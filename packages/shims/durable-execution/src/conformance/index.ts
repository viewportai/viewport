// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { DurableExecutionProvider } from '../interface.js';

export async function assertDurableExecutionProviderConformance(provider: DurableExecutionProvider): Promise<void> {
  if (!provider.id) throw new Error('DurableExecutionProvider.id is required');
  const first = await provider.startRun({
    runType: 'approval',
    idempotencyKey: 'wf_a',
    tenantId: 'tenant_a',
    workspaceId: 'workspace_a',
    runId: 'run_a',
    policyHash: 'sha256:policy_a',
    input: {},
  });
  const second = await provider.startRun({
    runType: 'approval',
    idempotencyKey: 'wf_a',
    tenantId: 'tenant_a',
    workspaceId: 'workspace_a',
    runId: 'run_a',
    policyHash: 'sha256:policy_a',
    input: {},
  });
  if (first.id !== second.id) throw new Error('DurableExecutionProvider.start must be idempotent');

  const wait = await provider.awaitGate({
    workflowId: first.id,
    gateId: 'gate_a',
    idempotencyKey: 'gate_wait_a',
    deadlineAt: new Date(Date.now() + 60_000),
  });
  if (wait.status !== 'waiting') throw new Error('DurableExecutionProvider.awaitGate must create a gate wait');

  const timeout = await provider.scheduleTimeout({
    workflowId: first.id,
    timeoutId: 'timeout_gate_a',
    fireAt: new Date(Date.now() + 60_000),
    payload: { gateId: 'gate_a' },
  });
  if (timeout.status !== 'scheduled') throw new Error('DurableExecutionProvider.scheduleTimeout must schedule once');

  const snapshot = await provider.getRun(first.id);
  if (!snapshot || snapshot.status !== 'waiting' || !snapshot.waitingGateIds.includes('gate_a')) {
    throw new Error('DurableExecutionProvider.getRun must expose waiting gates');
  }

  const accepted = await provider.signalGate({
    workflowId: first.id,
    gateId: 'gate_a',
    decisionId: 'decision_a',
    decision: 'approved',
    payload: {},
  });
  if (!accepted.accepted) throw new Error('DurableExecutionProvider.signalGate must accept first gate decision');

  await provider.signal({ workflowId: first.id, name: 'approved', payload: {} });

  const completed = await provider.completeRun({
    workflowId: first.id,
    idempotencyKey: 'complete_a',
    outcome: 'completed',
    payload: {},
  });
  if (!completed.completed) throw new Error('DurableExecutionProvider.completeRun must complete once');

  const duplicateCompletion = await provider.completeRun({
    workflowId: first.id,
    idempotencyKey: 'complete_a',
    outcome: 'completed',
    payload: {},
  });
  if (duplicateCompletion.completed) throw new Error('DurableExecutionProvider.completeRun must be idempotent');
}
