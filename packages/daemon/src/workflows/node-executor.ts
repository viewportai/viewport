import type { Daemon } from '../core/daemon.js';
import type { SessionMessage } from '../core/types.js';
import {
  addEvent,
  renderOptionalTemplate,
  renderTemplate,
  resolveNodeCwd,
  runShellNode,
  ShellNodeError,
} from './runtime-helpers.js';
import { isFailedSessionReason, waitForPromptSessionComplete } from './session-completion.js';
import { createSessionOutputCollector } from './session-output.js';
import type { WorkflowSessionLinkStore } from './session-links.js';
import { collectNodeArtifacts } from './artifact-collector.js';
import { executeLoopNode } from './loop-executor.js';
import {
  defaultWorktreePath,
  readPromptNodeOutput,
  readPromptNodeTranscriptExcerpt,
} from './prompt-output.js';
import { classifyRetry } from './retry-classifier.js';
import type { WorkflowNode, WorkflowRunRecord } from './types.js';

export interface WorkflowNodeExecutorContext {
  daemon: Daemon;
  sessionLinks: WorkflowSessionLinkStore;
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
      let artifactCwd = run.directoryPath;
      if (node.type === 'shell') {
        artifactCwd = resolveNodeCwd(
          run.directoryPath,
          await renderOptionalTemplate(node.cwd, run),
        );
        const result = await runShellNode(await renderTemplate(node.command, run), {
          cwd: artifactCwd,
          timeoutSeconds: node.timeoutSeconds,
          onOutput: ({ source, chunk, output }) => {
            addEvent(
              run,
              'node-log',
              `Node ${nodeId} wrote ${source}`,
              { source, chunk, output },
              nodeId,
            );
            run.updatedAt = Date.now();
            void context.saveAndEmit(run);
          },
        });
        state.output = result.output;
        state.exitCode = result.exitCode;
        addEvent(
          run,
          'node-output',
          `Node ${nodeId} produced shell output`,
          { output: result.output, exitCode: result.exitCode },
          nodeId,
        );
      } else if (node.type === 'prompt') {
        await executePromptNode(context, run, nodeId, node);
      } else if (node.type === 'approval') {
        await blockForApproval(context, run, nodeId, await renderTemplate(node.prompt, run));
        return 'blocked';
      } else if (node.type === 'gate') {
        const gateResult = await executeGateNode(context, run, nodeId, node);
        if (gateResult === 'blocked') return 'blocked';
      } else if (node.type === 'loop') {
        await executeLoopNode(context, run, nodeId, node);
      }

      await collectAndRecordArtifacts(context, run, nodeId, node, artifactCwd);

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
  addEvent(run, 'node-failed', `Node ${nodeId} failed: ${message}`, { attempts: attempt }, nodeId);
  await context.saveAndEmit(run);
  throw lastError instanceof Error ? lastError : new Error(message);
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

  const output = createSessionOutputCollector();
  const messageHandler = (event: { sessionId: string; message: SessionMessage }): void => {
    if (event.sessionId !== state.sessionId) return;
    output.push(event.message);
  };
  context.daemon.on('session:message', messageHandler);
  const sessionId = await context.daemon.launchSession(
    run.directoryId,
    await renderTemplate(node.prompt, run),
    {
      ...(node.agent ? { agent: node.agent } : {}),
      ...(node.model ? { model: node.model } : {}),
    },
  );
  state.sessionId = sessionId;
  state.nativeSessionId = context.daemon.getSessionNativeId(sessionId);
  state.worktreePath =
    readActiveSessionWorktreePath(context.daemon, sessionId) ?? defaultWorktreePath(run, sessionId);
  await context.sessionLinks.upsert({
    sessionId,
    nativeSessionId: state.nativeSessionId,
    workflowRunId: run.id,
    workflowNodeId: nodeId,
    parentDirectoryId: run.directoryId,
    parentDirectoryPath: run.directoryPath,
    worktreePath: state.worktreePath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  addEvent(
    run,
    'session-started',
    `Node ${nodeId} started session ${sessionId}`,
    {
      sessionId,
    },
    nodeId,
  );
  run.updatedAt = Date.now();
  await context.saveAndEmit(run);

  try {
    const reason = await waitForPromptSessionComplete(context.daemon, sessionId);
    const capturedOutput = output.text() || (await readPromptNodeOutput(run, state));
    if (capturedOutput && capturedOutput !== state.output) {
      state.output = capturedOutput;
      const transcriptExcerpt = await readPromptNodeTranscriptExcerpt(run, state);
      addEvent(
        run,
        'node-output',
        `Node ${nodeId} produced prompt output`,
        {
          output: capturedOutput,
          ...(transcriptExcerpt.length > 0 ? { transcriptExcerpt } : {}),
        },
        nodeId,
      );
    }
    addEvent(
      run,
      reason === 'idle' ? 'session-idle' : 'session-ended',
      `Node ${nodeId} session ${sessionId} ${reason === 'idle' ? 'became idle' : 'ended'}`,
      { sessionId, reason },
      nodeId,
    );
    if (isFailedSessionReason(reason)) {
      throw new Error(`Session ${sessionId} failed: ${reason}`);
    }
  } finally {
    context.daemon.off('session:message', messageHandler);
  }
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

function readActiveSessionWorktreePath(daemon: Daemon, sessionId: string): string | undefined {
  try {
    return daemon.getSessionWorktreePath(sessionId);
  } catch {
    return undefined;
  }
}
