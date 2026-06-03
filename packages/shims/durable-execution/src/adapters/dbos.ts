// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import { DBOS } from '@dbos-inc/dbos-sdk';

import type {
  DurableExecutionProvider,
  DurableGateSignal,
  DurableGateWait,
  DurableGateWaitHandle,
  DurableRunCompletion,
  DurableRunHandle,
  DurableRunSnapshot,
  DurableRunStart,
  DurableTimeoutHandle,
  DurableTimeoutSchedule,
  DurableWorkflowSignal,
} from '../interface.js';

interface DbosDurableExecutionProviderOptions {
  systemDatabaseUrl: string;
  applicationName?: string;
}

interface DurableRunState {
  id: string;
  status: DurableRunSnapshot['status'];
  runId: string;
  policyHash: string;
  waitingGateIds: string[];
  scheduledTimeoutIds: string[];
  gateWaitKeys: string[];
  gateSignalIds: string[];
  gateDeadlines: Record<string, number | undefined>;
  completionKeys: string[];
  completedAt?: string;
}

type DurableRunCommand =
  | {
      type: 'await_gate';
      gateId: string;
      idempotencyKey: string;
      deadlineAtEpochMs?: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'schedule_timeout';
      timeoutId: string;
      fireAtEpochMs: number;
      payload: Record<string, unknown>;
    }
  | {
      type: 'signal';
      name: string;
      payload: Record<string, unknown>;
    }
  | {
      type: 'signal_gate';
      gateId: string;
      decisionId: string;
      decision: string;
      payload: Record<string, unknown>;
    }
  | {
      type: 'complete';
      idempotencyKey: string;
      outcome: DurableRunCompletion['outcome'];
      payload: Record<string, unknown>;
    };

const COMMAND_TOPIC = 'viewport-durable-command';
const SNAPSHOT_EVENT = 'snapshot';

const viewportDurableRunWorkflow = DBOS.registerWorkflow(
  async (input: DurableRunStart) => {
    const state: DurableRunState = {
      id: DBOS.workflowID!,
      status: 'running',
      runId: input.runId,
      policyHash: input.policyHash,
      waitingGateIds: [],
      scheduledTimeoutIds: [],
      gateWaitKeys: [],
      gateSignalIds: [],
      gateDeadlines: {},
      completionKeys: [],
    };

    await persistSnapshot(state);

    while (state.status === 'running' || state.status === 'waiting') {
      if (expireDueGates(state)) {
        await persistSnapshot(state);
      }
      const command = await DBOS.recv<DurableRunCommand>(COMMAND_TOPIC, nextCommandTimeoutSeconds(state));
      if (!command) continue;
      expireDueGates(state);

      if (command.type === 'await_gate') {
        if (state.gateSignalIds.includes(command.gateId)) {
          await persistSnapshot(state);
          continue;
        }
        if (!state.gateWaitKeys.includes(command.idempotencyKey)) {
          state.gateWaitKeys.push(command.idempotencyKey);
          state.waitingGateIds = unique([...state.waitingGateIds, command.gateId]);
          state.gateDeadlines[command.gateId] = command.deadlineAtEpochMs;
          state.status = 'waiting';
          await persistSnapshot(state);
        }
        continue;
      }

      if (command.type === 'schedule_timeout') {
        state.scheduledTimeoutIds = unique([...state.scheduledTimeoutIds, command.timeoutId]);
        await persistSnapshot(state);
        continue;
      }

      if (command.type === 'signal') {
        await DBOS.setEvent(`signal:${command.name}`, command.payload);
        await persistSnapshot(state);
        continue;
      }

      if (command.type === 'signal_gate') {
        if (state.waitingGateIds.includes(command.gateId)) {
          state.gateSignalIds = unique([...state.gateSignalIds, command.gateId]);
          state.waitingGateIds = state.waitingGateIds.filter((gateId) => gateId !== command.gateId);
          delete state.gateDeadlines[command.gateId];
          state.status = state.waitingGateIds.length > 0 ? 'waiting' : 'running';
        }
        await persistSnapshot(state);
        continue;
      }

      if (command.type === 'complete') {
        if (!state.completionKeys.includes(command.idempotencyKey)) {
          state.completionKeys.push(command.idempotencyKey);
          state.status = command.outcome;
          state.completedAt = new Date().toISOString();
          state.waitingGateIds = [];
        }
        await persistSnapshot(state);
        return snapshotFromState(state);
      }
    }

    return snapshotFromState(state);
  },
  { name: 'viewport-durable-run' },
);

export class DbosDurableExecutionProvider implements DurableExecutionProvider {
  readonly id = 'dbos';

  private launched = false;

  constructor(private readonly options: DbosDurableExecutionProviderOptions) {}

  async startRun(input: DurableRunStart): Promise<DurableRunHandle> {
    await this.launch();
    const handle = await DBOS.startWorkflow(viewportDurableRunWorkflow, { workflowID: input.idempotencyKey })(input);
    const snapshot = await this.waitForSnapshot(handle.workflowID);
    return {
      id: handle.workflowID,
      status: snapshot.runId === input.runId ? 'started' : 'already_started',
    };
  }

  async awaitGate(wait: DurableGateWait): Promise<DurableGateWaitHandle> {
    await this.launch();
    const snapshot = await this.getRun(wait.workflowId);
    if (!snapshot) throw new Error(`Unknown durable workflow: ${wait.workflowId}`);
    if (!snapshot.waitingGateIds.includes(wait.gateId)) {
      await DBOS.send(wait.workflowId, commandForGateWait(wait), COMMAND_TOPIC, wait.idempotencyKey);
      const updated = await this.waitUntil(
        wait.workflowId,
        (next) => next.waitingGateIds.includes(wait.gateId) || !isActiveStatus(next.status),
      );
      if (!updated.waitingGateIds.includes(wait.gateId)) {
        return { id: wait.gateId, status: 'already_resolved' };
      }
      return { id: wait.gateId, status: 'waiting' };
    }
    return {
      id: wait.gateId,
      status: 'already_waiting',
    };
  }

  async signalGate(signal: DurableGateSignal): Promise<{ accepted: boolean }> {
    await this.launch();
    const before = await this.getRun(signal.workflowId);
    if (!before) throw new Error(`Unknown durable workflow: ${signal.workflowId}`);
    if (!before.waitingGateIds.includes(signal.gateId)) {
      return { accepted: false };
    }
    await DBOS.send(signal.workflowId, commandForGateSignal(signal), COMMAND_TOPIC, signal.decisionId);
    await this.waitUntil(signal.workflowId, (snapshot) => !snapshot.waitingGateIds.includes(signal.gateId));
    return { accepted: true };
  }

  async scheduleTimeout(timeout: DurableTimeoutSchedule): Promise<DurableTimeoutHandle> {
    await this.launch();
    const snapshot = await this.getRun(timeout.workflowId);
    if (!snapshot) throw new Error(`Unknown durable workflow: ${timeout.workflowId}`);
    if (!snapshot.scheduledTimeoutIds.includes(timeout.timeoutId)) {
      await DBOS.send(timeout.workflowId, commandForTimeout(timeout), COMMAND_TOPIC, timeout.timeoutId);
      await this.waitUntil(timeout.workflowId, (updated) => updated.scheduledTimeoutIds.includes(timeout.timeoutId));
      return { id: timeout.timeoutId, status: 'scheduled' };
    }
    return { id: timeout.timeoutId, status: 'already_scheduled' };
  }

  async signal(signal: DurableWorkflowSignal): Promise<{ accepted: boolean }> {
    await this.launch();
    await DBOS.send(signal.workflowId, { type: 'signal', name: signal.name, payload: signal.payload }, COMMAND_TOPIC);
    return { accepted: true };
  }

  async completeRun(completion: DurableRunCompletion): Promise<{ completed: boolean }> {
    await this.launch();
    const snapshot = await this.getRun(completion.workflowId);
    if (!snapshot) throw new Error(`Unknown durable workflow: ${completion.workflowId}`);
    if (snapshot.status === completion.outcome && snapshot.completedAt) {
      return { completed: false };
    }
    await DBOS.send(completion.workflowId, commandForCompletion(completion), COMMAND_TOPIC, completion.idempotencyKey);
    const updated = await this.waitUntil(completion.workflowId, (next) => next.status === completion.outcome);
    await DBOS.retrieveWorkflow(completion.workflowId).getResult();
    return { completed: Boolean(updated.completedAt) };
  }

  async getRun(workflowId: string): Promise<DurableRunSnapshot | null> {
    await this.launch();
    const snapshot = await DBOS.getEvent<DurableRunSnapshot>(workflowId, SNAPSHOT_EVENT, 0);
    return snapshot ?? null;
  }

  async shutdown(): Promise<void> {
    if (!this.launched) return;
    await DBOS.shutdown({ deregister: false });
    this.launched = false;
  }

  private async launch(): Promise<void> {
    if (this.launched) return;
    DBOS.setConfig({
      name: this.options.applicationName ?? 'viewport-durable-execution',
      systemDatabaseUrl: this.options.systemDatabaseUrl,
      runAdminServer: false,
    });
    await DBOS.launch();
    this.launched = true;
  }

  private async waitForSnapshot(workflowId: string): Promise<DurableRunSnapshot> {
    return this.waitUntil(workflowId, () => true);
  }

  private async waitUntil(workflowId: string, predicate: (snapshot: DurableRunSnapshot) => boolean) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snapshot = await this.getRun(workflowId);
      if (snapshot && predicate(snapshot)) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for durable workflow snapshot: ${workflowId}`);
  }
}

function commandForGateSignal(signal: DurableGateSignal): DurableRunCommand {
  return {
    type: 'signal_gate',
    gateId: signal.gateId,
    decisionId: signal.decisionId,
    decision: signal.decision,
    payload: signal.payload,
  };
}

function commandForGateWait(wait: DurableGateWait): DurableRunCommand {
  return {
    type: 'await_gate',
    gateId: wait.gateId,
    idempotencyKey: wait.idempotencyKey,
    deadlineAtEpochMs: wait.deadlineAt?.getTime(),
    metadata: wait.metadata,
  };
}

function commandForTimeout(timeout: DurableTimeoutSchedule): DurableRunCommand {
  return {
    type: 'schedule_timeout',
    timeoutId: timeout.timeoutId,
    fireAtEpochMs: timeout.fireAt.getTime(),
    payload: timeout.payload,
  };
}

function commandForCompletion(completion: DurableRunCompletion): DurableRunCommand {
  return {
    type: 'complete',
    idempotencyKey: completion.idempotencyKey,
    outcome: completion.outcome,
    payload: completion.payload,
  };
}

async function persistSnapshot(state: DurableRunState): Promise<void> {
  await DBOS.setEvent(SNAPSHOT_EVENT, snapshotFromState(state));
}

function snapshotFromState(state: DurableRunState): DurableRunSnapshot {
  return {
    id: state.id,
    status: state.status,
    runId: state.runId,
    policyHash: state.policyHash,
    waitingGateIds: [...state.waitingGateIds],
    scheduledTimeoutIds: [...state.scheduledTimeoutIds],
    completedAt: state.completedAt ? new Date(state.completedAt) : undefined,
  };
}

function nextCommandTimeoutSeconds(state: DurableRunState): number | undefined {
  const deadlines = Object.values(state.gateDeadlines)
    .filter((value): value is number => typeof value === 'number')
    .filter((value) => value > Date.now());
  if (deadlines.length === 0) return undefined;
  return Math.max(0, Math.ceil((Math.min(...deadlines) - Date.now()) / 1000));
}

function expireDueGates(state: DurableRunState): boolean {
  const now = Date.now();
  const expiredGateIds = Object.entries(state.gateDeadlines)
    .filter(([, deadline]) => typeof deadline === 'number' && deadline <= now)
    .map(([gateId]) => gateId);
  if (expiredGateIds.length === 0) return false;

  state.waitingGateIds = state.waitingGateIds.filter((gateId) => !expiredGateIds.includes(gateId));
  for (const gateId of expiredGateIds) {
    delete state.gateDeadlines[gateId];
  }
  state.status = state.waitingGateIds.length > 0 ? 'waiting' : 'running';
  return true;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isActiveStatus(status: DurableRunSnapshot['status']): boolean {
  return status === 'running' || status === 'waiting';
}
