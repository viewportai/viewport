// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export interface DurableWorkflowStart {
  workflowName: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
}

export interface DurableWorkflowHandle {
  id: string;
  status: 'started' | 'already_started';
}

export interface DurableSignal {
  workflowId: string;
  name: string;
  payload: Record<string, unknown>;
}

export interface DurableExecutionProvider {
  readonly id: string;
  start(input: DurableWorkflowStart): Promise<DurableWorkflowHandle>;
  signal(signal: DurableSignal): Promise<{ accepted: boolean }>;
}
