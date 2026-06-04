// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { DurableExecutionProvider } from '../interface.js';

export async function assertDurableExecutionProviderConformance(provider: DurableExecutionProvider): Promise<void> {
  if (!provider.id) throw new Error('DurableExecutionProvider.id is required');
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const workflowKey = `wf_${suffix}`;
  const tenantId = `tenant_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const runId = `run_${suffix}`;
  const gateId = `gate_${suffix}`;
  const gateWaitKey = `gate_wait_${suffix}`;
  const timeoutId = `timeout_${suffix}`;
  const sideEffectId = `side_effect_${suffix}`;
  const decisionId = `decision_${suffix}`;
  const completeKey = `complete_${suffix}`;
  const first = await provider.startRun({
    runType: 'approval',
    idempotencyKey: workflowKey,
    tenantId,
    workspaceId,
    runId,
    policyHash: 'sha256:policy_a',
    input: {},
  });
  const second = await provider.startRun({
    runType: 'approval',
    idempotencyKey: workflowKey,
    tenantId,
    workspaceId,
    runId,
    policyHash: 'sha256:policy_a',
    input: {},
  });
  if (first.id !== second.id) throw new Error('DurableExecutionProvider.start must be idempotent');

  const wait = await provider.awaitGate({
    workflowId: first.id,
    gateId,
    idempotencyKey: gateWaitKey,
    deadlineAt: new Date(Date.now() + 60_000),
  });
  if (wait.status !== 'waiting') throw new Error('DurableExecutionProvider.awaitGate must create a gate wait');

  const timeout = await provider.scheduleTimeout({
    workflowId: first.id,
    timeoutId,
    fireAt: new Date(Date.now() + 60_000),
    payload: { gateId },
  });
  if (timeout.status !== 'scheduled') throw new Error('DurableExecutionProvider.scheduleTimeout must schedule once');

  const snapshot = await provider.getRun(first.id);
  if (!snapshot || snapshot.status !== 'waiting' || !snapshot.waitingGateIds.includes(gateId)) {
    throw new Error('DurableExecutionProvider.getRun must expose waiting gates');
  }

  const claim = await provider.claimSideEffect({
    workflowId: first.id,
    sideEffectId,
    idempotencyKey: `claim_${suffix}`,
    kind: 'github.pull_request.create',
    externalKey: 'repo:branch',
    payload: {},
  });
  if (claim.status !== 'claimed') throw new Error('DurableExecutionProvider.claimSideEffect must claim once');

  const duplicateClaim = await provider.claimSideEffect({
    workflowId: first.id,
    sideEffectId,
    idempotencyKey: `claim_${suffix}`,
    kind: 'github.pull_request.create',
    externalKey: 'repo:branch',
    payload: {},
  });
  if (duplicateClaim.status !== 'already_claimed') {
    throw new Error('DurableExecutionProvider.claimSideEffect must be idempotent before completion');
  }

  const sideEffectCompletion = await provider.completeSideEffect({
    workflowId: first.id,
    sideEffectId,
    idempotencyKey: `side_effect_complete_${suffix}`,
    result: { externalUrl: 'https://example.test/pr/1' },
  });
  if (!sideEffectCompletion.completed) {
    throw new Error('DurableExecutionProvider.completeSideEffect must complete the first side effect result');
  }

  const completedClaim = await provider.claimSideEffect({
    workflowId: first.id,
    sideEffectId,
    idempotencyKey: `claim_${suffix}`,
    kind: 'github.pull_request.create',
    externalKey: 'repo:branch',
    payload: {},
  });
  if (completedClaim.status !== 'already_completed' || completedClaim.result?.['externalUrl'] !== 'https://example.test/pr/1') {
    throw new Error('DurableExecutionProvider.claimSideEffect must return completed side effect results');
  }

  const accepted = await provider.signalGate({
    workflowId: first.id,
    gateId,
    decisionId,
    decision: 'approved',
    payload: {},
  });
  if (!accepted.accepted) throw new Error('DurableExecutionProvider.signalGate must accept first gate decision');

  await provider.signal({ workflowId: first.id, name: 'approved', payload: {} });

  const completed = await provider.completeRun({
    workflowId: first.id,
    idempotencyKey: completeKey,
    outcome: 'completed',
    payload: {},
  });
  if (!completed.completed) throw new Error('DurableExecutionProvider.completeRun must complete once');

  const duplicateCompletion = await provider.completeRun({
    workflowId: first.id,
    idempotencyKey: completeKey,
    outcome: 'completed',
    payload: {},
  });
  if (duplicateCompletion.completed) throw new Error('DurableExecutionProvider.completeRun must be idempotent');
}
