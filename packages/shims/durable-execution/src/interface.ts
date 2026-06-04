// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export interface DurableRunStart {
  runType: string;
  idempotencyKey: string;
  tenantId: string;
  workspaceId: string;
  runId: string;
  policyHash: string;
  input: Record<string, unknown>;
}

export interface DurableRunHandle {
  id: string;
  status: 'started' | 'already_started';
}

export interface DurableGateWait {
  workflowId: string;
  gateId: string;
  idempotencyKey: string;
  deadlineAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface DurableGateWaitHandle {
  id: string;
  status: 'waiting' | 'already_waiting' | 'already_resolved';
}

export interface DurableGateSignal {
  workflowId: string;
  gateId: string;
  decisionId: string;
  decision: 'approved' | 'rejected' | 'canceled' | (string & {});
  payload: Record<string, unknown>;
}

export interface DurableTimeoutSchedule {
  workflowId: string;
  timeoutId: string;
  fireAt: Date;
  payload: Record<string, unknown>;
}

export interface DurableTimeoutHandle {
  id: string;
  status: 'scheduled' | 'already_scheduled';
}

export interface DurableRunCompletion {
  workflowId: string;
  idempotencyKey: string;
  outcome: 'completed' | 'failed' | 'canceled';
  payload: Record<string, unknown>;
}

export interface DurableSideEffectClaim {
  workflowId: string;
  sideEffectId: string;
  idempotencyKey: string;
  kind: string;
  externalKey?: string;
  payload: Record<string, unknown>;
}

export interface DurableSideEffectClaimHandle {
  id: string;
  status: 'claimed' | 'already_claimed' | 'already_completed';
  result?: Record<string, unknown>;
}

export interface DurableSideEffectCompletion {
  workflowId: string;
  sideEffectId: string;
  idempotencyKey: string;
  result: Record<string, unknown>;
}

export interface DurableSideEffectSnapshot {
  id: string;
  kind: string;
  externalKey?: string;
  status: 'claimed' | 'completed';
  result?: Record<string, unknown>;
  completedAt?: Date;
}

export interface DurableRunSnapshot {
  id: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'canceled';
  runId: string;
  policyHash: string;
  waitingGateIds: string[];
  scheduledTimeoutIds: string[];
  sideEffects: DurableSideEffectSnapshot[];
  completedAt?: Date;
}

export interface DurableWorkflowSignal {
  workflowId: string;
  name: string;
  payload: Record<string, unknown>;
}

export interface DurableExecutionProvider {
  readonly id: string;
  startRun(input: DurableRunStart): Promise<DurableRunHandle>;
  awaitGate(wait: DurableGateWait): Promise<DurableGateWaitHandle>;
  signalGate(signal: DurableGateSignal): Promise<{ accepted: boolean }>;
  scheduleTimeout(timeout: DurableTimeoutSchedule): Promise<DurableTimeoutHandle>;
  claimSideEffect(claim: DurableSideEffectClaim): Promise<DurableSideEffectClaimHandle>;
  completeSideEffect(completion: DurableSideEffectCompletion): Promise<{ completed: boolean; result: Record<string, unknown> }>;
  signal(signal: DurableWorkflowSignal): Promise<{ accepted: boolean }>;
  completeRun(completion: DurableRunCompletion): Promise<{ completed: boolean }>;
  getRun(workflowId: string): Promise<DurableRunSnapshot | null>;
}
