// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type {
  DurableExecutionProvider,
  DurableGateSignal,
  DurableGateWait,
  DurableGateWaitHandle,
  DurableRunCompletion,
  DurableRunHandle,
  DurableRunSnapshot,
  DurableRunStart,
  DurableSideEffectClaim,
  DurableSideEffectClaimHandle,
  DurableSideEffectCompletion,
  DurableSideEffectSnapshot,
  DurableTimeoutHandle,
  DurableTimeoutSchedule,
  DurableWorkflowSignal,
} from '../interface.js';

interface StoredRun extends Omit<DurableRunSnapshot, 'sideEffects'> {
  idempotencyKey: string;
  gateWaits: Map<string, DurableGateWait>;
  gateSignals: Map<string, DurableGateSignal>;
  timeouts: Map<string, DurableTimeoutSchedule>;
  signals: DurableWorkflowSignal[];
  completionKeys: Set<string>;
  sideEffects: Map<string, DurableSideEffectSnapshot & { claimKey: string; completionKeys: Set<string> }>;
}

export class InMemoryDurableExecutionProvider implements DurableExecutionProvider {
  readonly id = 'in-memory';

  private readonly runsByWorkflowId = new Map<string, StoredRun>();
  private readonly workflowIdByIdempotencyKey = new Map<string, string>();

  async startRun(input: DurableRunStart): Promise<DurableRunHandle> {
    const existingId = this.workflowIdByIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      return { id: existingId, status: 'already_started' };
    }

    const id = `wf_${this.workflowIdByIdempotencyKey.size + 1}`;
    this.workflowIdByIdempotencyKey.set(input.idempotencyKey, id);
    this.runsByWorkflowId.set(id, {
      id,
      idempotencyKey: input.idempotencyKey,
      status: 'running',
      runId: input.runId,
      policyHash: input.policyHash,
      waitingGateIds: [],
      scheduledTimeoutIds: [],
      gateWaits: new Map(),
      gateSignals: new Map(),
      timeouts: new Map(),
      signals: [],
      completionKeys: new Set(),
      sideEffects: new Map(),
    });

    return { id, status: 'started' };
  }

  async awaitGate(wait: DurableGateWait): Promise<DurableGateWaitHandle> {
    const run = this.requireRun(wait.workflowId);
    if (run.gateSignals.has(wait.gateId)) {
      return { id: wait.gateId, status: 'already_resolved' };
    }
    if (run.gateWaits.has(wait.idempotencyKey)) {
      return { id: wait.gateId, status: 'already_waiting' };
    }

    run.status = 'waiting';
    run.gateWaits.set(wait.idempotencyKey, wait);
    run.waitingGateIds = unique([...run.waitingGateIds, wait.gateId]);

    return { id: wait.gateId, status: 'waiting' };
  }

  async signalGate(signal: DurableGateSignal): Promise<{ accepted: boolean }> {
    const run = this.requireRun(signal.workflowId);
    if (run.gateSignals.has(signal.gateId)) {
      return { accepted: false };
    }

    run.gateSignals.set(signal.gateId, signal);
    run.waitingGateIds = run.waitingGateIds.filter((gateId) => gateId !== signal.gateId);
    if (run.status === 'waiting' && run.waitingGateIds.length === 0) {
      run.status = 'running';
    }

    return { accepted: true };
  }

  async scheduleTimeout(timeout: DurableTimeoutSchedule): Promise<DurableTimeoutHandle> {
    const run = this.requireRun(timeout.workflowId);
    if (run.timeouts.has(timeout.timeoutId)) {
      return { id: timeout.timeoutId, status: 'already_scheduled' };
    }

    run.timeouts.set(timeout.timeoutId, timeout);
    run.scheduledTimeoutIds = unique([...run.scheduledTimeoutIds, timeout.timeoutId]);

    return { id: timeout.timeoutId, status: 'scheduled' };
  }

  async claimSideEffect(claim: DurableSideEffectClaim): Promise<DurableSideEffectClaimHandle> {
    const run = this.requireRun(claim.workflowId);
    const existing = run.sideEffects.get(claim.sideEffectId);
    if (existing?.status === 'completed') {
      return { id: claim.sideEffectId, status: 'already_completed', result: existing.result };
    }
    if (existing) {
      return { id: claim.sideEffectId, status: 'already_claimed' };
    }

    run.sideEffects.set(claim.sideEffectId, {
      id: claim.sideEffectId,
      kind: claim.kind,
      externalKey: claim.externalKey,
      status: 'claimed',
      claimKey: claim.idempotencyKey,
      completionKeys: new Set(),
    });

    return { id: claim.sideEffectId, status: 'claimed' };
  }

  async completeSideEffect(completion: DurableSideEffectCompletion): Promise<{ completed: boolean; result: Record<string, unknown> }> {
    const run = this.requireRun(completion.workflowId);
    const sideEffect = run.sideEffects.get(completion.sideEffectId);
    if (!sideEffect) {
      throw new Error(`Unknown durable side effect: ${completion.sideEffectId}`);
    }
    if (sideEffect.completionKeys.has(completion.idempotencyKey)) {
      return { completed: false, result: sideEffect.result ?? {} };
    }

    sideEffect.completionKeys.add(completion.idempotencyKey);
    sideEffect.status = 'completed';
    sideEffect.result = completion.result;
    sideEffect.completedAt = new Date();

    return { completed: true, result: sideEffect.result };
  }

  async signal(signal: DurableWorkflowSignal): Promise<{ accepted: boolean }> {
    const run = this.requireRun(signal.workflowId);
    run.signals.push(signal);
    return { accepted: true };
  }

  async completeRun(completion: DurableRunCompletion): Promise<{ completed: boolean }> {
    const run = this.requireRun(completion.workflowId);
    if (run.completionKeys.has(completion.idempotencyKey)) {
      return { completed: false };
    }

    run.completionKeys.add(completion.idempotencyKey);
    run.status = completion.outcome;
    run.completedAt = new Date();
    run.waitingGateIds = [];

    return { completed: true };
  }

  async getRun(workflowId: string): Promise<DurableRunSnapshot | null> {
    const run = this.runsByWorkflowId.get(workflowId);
    if (!run) return null;

    return {
      id: run.id,
      status: run.status,
      runId: run.runId,
      policyHash: run.policyHash,
      waitingGateIds: [...run.waitingGateIds],
      scheduledTimeoutIds: [...run.scheduledTimeoutIds],
      sideEffects: [...run.sideEffects.values()].map((sideEffect) => ({
        id: sideEffect.id,
        kind: sideEffect.kind,
        externalKey: sideEffect.externalKey,
        status: sideEffect.status,
        result: sideEffect.result,
        completedAt: sideEffect.completedAt,
      })),
      completedAt: run.completedAt,
    };
  }

  private requireRun(workflowId: string): StoredRun {
    const run = this.runsByWorkflowId.get(workflowId);
    if (!run) {
      throw new Error(`Unknown durable workflow: ${workflowId}`);
    }

    return run;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
