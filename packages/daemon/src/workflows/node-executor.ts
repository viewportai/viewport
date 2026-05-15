import type { Daemon } from '../core/daemon.js';
import { addEvent, renderTemplate, ShellNodeError } from './runtime-helpers.js';
import type { WorkflowSessionLinkStore } from './session-links.js';
import { collectNodeArtifacts } from './artifact-collector.js';
import { readPromptNodeOutput, readPromptNodeTranscriptExcerpt } from './prompt-output.js';
import { classifyRetry } from './retry-classifier.js';
import { NODE_EXECUTORS } from './node-registry.js';
import { runWorkflowDaemonSession } from './daemon-session.js';
import { appendInlineAgentResults, runInlineAgents } from './inline-agents.js';
import type { WorkflowShellAbortRegistry } from './shell-abort-registry.js';
import type { WorkflowNode, WorkflowRunRecord } from './types.js';

export interface WorkflowNodeExecutorContext {
  daemon: Daemon;
  sessionLinks: WorkflowSessionLinkStore;
  shellAbortRegistry: WorkflowShellAbortRegistry;
  saveAndEmit: (run: WorkflowRunRecord) => Promise<void>;
}

export async function executeWorkflowNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
): Promise<'completed' | 'blocked'> {
  const state = run.nodes[nodeId];
  if (!state) return 'completed';
  if (state.status === 'completed' || state.status === 'skipped') return 'completed';

  state.status = 'running';
  state.startedAt = Date.now();
  run.updatedAt = state.startedAt;
  addEvent(run, 'node-started', `Node ${nodeId} started`, undefined, nodeId);
  await context.saveAndEmit(run);

  const maxAttempts = node.retry?.maxAttempts ?? 1;
  const backoffMs = (node.retry?.backoffSeconds ?? 0) * 1000;
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      // Look up the per-type executor in the registry. Built-ins are
      // registered in `node-registry.ts`; the plugin loader will extend the
      // same map with `defineNode()` registrations from
      // `~/.viewport/plugins.json` once that integration ships.
      const executor = NODE_EXECUTORS.get(node.type);
      if (!executor) {
        throw new Error(`No executor registered for node type '${node.type}' on node ${nodeId}.`);
      }
      const outcome = await executor(context, run, nodeId, node, {
        executePromptNode,
        executeGateNode,
        blockForApproval,
      });
      if (outcome.result === 'blocked') return 'blocked';

      await collectAndRecordArtifacts(
        context,
        run,
        nodeId,
        node,
        outcome.artifactCwd ?? run.directoryPath,
      );

      state.status = 'completed';
      state.completedAt = Date.now();
      run.updatedAt = state.completedAt;
      addEvent(run, 'node-completed', `Node ${nodeId} completed`, undefined, nodeId);
      await context.saveAndEmit(run);
      return 'completed';
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ShellNodeError) {
        state.output = error.output || state.output;
        state.exitCode = error.exitCode ?? undefined;
      }
      const decision = classifyRetry(message, node.retry);
      const remaining = maxAttempts - attempt;
      if (decision === 'retry' && remaining > 0) {
        addEvent(
          run,
          'node-retry',
          `Node ${nodeId} retry ${attempt + 1}/${maxAttempts}: ${message}`,
          { attempt, message, backoffMs },
          nodeId,
        );
        run.updatedAt = Date.now();
        await context.saveAndEmit(run);
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      break;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  state.status = 'failed';
  state.error = message;
  state.completedAt = Date.now();
  state.attempts = attempt;
  run.updatedAt = state.completedAt;
  if (node.type === 'action') {
    const action = isRecord(state.metadata?.['action']) ? state.metadata['action'] : {};
    const idempotencyKey = typeof action['idempotencyKey'] === 'string' ? action['idempotencyKey'] : null;
    const digest = typeof action['digest'] === 'string' ? action['digest'] : null;
    const recovery = {
      state: 'dead_letter',
      reason: message,
      attempts: attempt,
      retryableByRerun: Boolean(idempotencyKey),
      idempotencyKey,
      digest,
    };
    state.metadata = {
      ...(state.metadata ?? {}),
      action: {
        ...action,
        recovery,
      },
    };
    addEvent(
      run,
      'action-dead-letter',
      `Action node ${nodeId} needs remediation after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
      recovery,
      nodeId,
    );
  }
  addEvent(run, 'node-failed', `Node ${nodeId} failed: ${message}`, { attempts: attempt }, nodeId);
  await context.saveAndEmit(run);
  throw lastError instanceof Error ? lastError : new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function executeGateNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: Extract<WorkflowNode, { type: 'gate' }>,
): Promise<'completed' | 'blocked'> {
  const gate = node.gate;
  if (gate.type === 'human_review') {
    await blockForApproval(context, run, nodeId, await renderTemplate(gate.prompt, run));
    addEvent(run, 'gate-blocked', `Human review gate ${nodeId} is waiting`, { gate }, nodeId);
    await context.saveAndEmit(run);
    return 'blocked';
  }

  if (gate.type === 'schedule') {
    const waitUntil = new Date(await renderTemplate(gate.waitUntil, run));
    if (!Number.isFinite(waitUntil.getTime())) {
      throw new Error(`Schedule gate ${nodeId} has an invalid waitUntil value`);
    }
    if (waitUntil.getTime() > Date.now()) {
      const state = run.nodes[nodeId];
      if (state) {
        state.status = 'blocked';
        state.output = `Waiting until ${waitUntil.toISOString()}`;
      }
      run.status = 'blocked';
      run.updatedAt = Date.now();
      addEvent(
        run,
        'gate-blocked',
        `Schedule gate ${nodeId} is waiting until ${waitUntil.toISOString()}`,
        { gate, waitUntil: waitUntil.toISOString() },
        nodeId,
      );
      await context.saveAndEmit(run);
      return 'blocked';
    }

    setGateOutput(run, nodeId, `Schedule reached: ${waitUntil.toISOString()}`);
    addEvent(
      run,
      'gate-passed',
      `Schedule gate ${nodeId} passed`,
      { gate, waitUntil: waitUntil.toISOString() },
      nodeId,
    );
    return 'completed';
  }

  const rendered = await renderTemplate(gate.expression, run);
  if (!isTruthyGateValue(rendered)) {
    throw new Error(`${gate.type} gate ${nodeId} failed: ${rendered || 'false'}`);
  }

  setGateOutput(run, nodeId, rendered);
  addEvent(
    run,
    'gate-passed',
    `${gate.type} gate ${nodeId} passed`,
    { gate, result: rendered },
    nodeId,
  );
  return 'completed';
}

function setGateOutput(run: WorkflowRunRecord, nodeId: string, output: string): void {
  const state = run.nodes[nodeId];
  if (state) state.output = output;
}

function isTruthyGateValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'pass', 'passed', 'ok'].includes(normalized);
}

async function collectAndRecordArtifacts(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
  cwd: string,
): Promise<void> {
  if (!node.artifacts || Object.keys(node.artifacts).length === 0) return;
  const result = await collectNodeArtifacts(run, nodeId, node, cwd);
  for (const artifact of result.artifacts) {
    run.artifacts ??= [];
    run.artifacts = run.artifacts.filter(
      (existing) => existing.nodeId !== artifact.nodeId || existing.name !== artifact.name,
    );
    run.artifacts.push(artifact);
    addEvent(
      run,
      'artifact-collected',
      `Node ${nodeId} collected artifact ${artifact.name}`,
      { artifact },
      nodeId,
    );
  }
  for (const missing of result.missing) {
    addEvent(
      run,
      'artifact-missing',
      `Node ${nodeId} did not collect artifact ${missing.name}: ${missing.reason}`,
      missing,
      nodeId,
    );
  }
  if (result.artifacts.length > 0 || result.missing.length > 0) {
    run.updatedAt = Date.now();
    await context.saveAndEmit(run);
  }
}

async function executePromptNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: Extract<WorkflowNode, { type: 'prompt' }>,
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;
  const inlineAgents = await runInlineAgents(context, run, nodeId, node);

  await runWorkflowDaemonSession(context, {
    run,
    nodeId,
    target: state,
    prompt: appendInlineAgentResults(await renderTemplate(node.prompt, run), inlineAgents),
    ...(node.agent ? { agent: node.agent } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.hooks ? { hooks: node.hooks } : {}),
    ...(node.timeoutSeconds ? { timeoutSeconds: node.timeoutSeconds } : {}),
    outputFallback: () => readPromptNodeOutput(run, state),
    outputData: async () => {
      const transcriptExcerpt = await readPromptNodeTranscriptExcerpt(run, state);
      return transcriptExcerpt.length > 0 ? { transcriptExcerpt } : {};
    },
  });
}

async function blockForApproval(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  prompt: string,
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;

  state.status = 'blocked';
  state.approval = {
    prompt,
    requestedAt: Date.now(),
  };
  run.status = 'blocked';
  run.updatedAt = state.approval.requestedAt;
  addEvent(run, 'approval-requested', `Approval requested for node ${nodeId}`, { prompt }, nodeId);
  addEvent(run, 'run-blocked', `Workflow blocked by approval gate: ${nodeId}`, undefined, nodeId);
  await context.saveAndEmit(run);
}
