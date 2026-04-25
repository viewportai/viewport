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
import { defaultWorktreePath, readPromptNodeOutput } from './prompt-output.js';
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

  try {
    if (node.type === 'shell') {
      const result = await runShellNode(renderTemplate(node.command, run), {
        cwd: resolveNodeCwd(run.directoryPath, renderOptionalTemplate(node.cwd, run)),
        timeoutSeconds: node.timeoutSeconds,
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
      await blockForApproval(context, run, nodeId, renderTemplate(node.prompt, run));
      return 'blocked';
    }

    state.status = 'completed';
    state.completedAt = Date.now();
    run.updatedAt = state.completedAt;
    addEvent(run, 'node-completed', `Node ${nodeId} completed`, undefined, nodeId);
    await context.saveAndEmit(run);
    return 'completed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ShellNodeError) {
      state.output = error.output || state.output;
      state.exitCode = error.exitCode ?? undefined;
    }
    state.status = 'failed';
    state.error = message;
    state.completedAt = Date.now();
    run.status = 'failed';
    run.error = message;
    run.completedAt = state.completedAt;
    run.updatedAt = state.completedAt;
    addEvent(run, 'node-failed', `Node ${nodeId} failed: ${message}`, undefined, nodeId);
    addEvent(run, 'run-failed', `Workflow run failed: ${message}`);
    await context.saveAndEmit(run);
    throw error;
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
    renderTemplate(node.prompt, run),
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
      addEvent(
        run,
        'node-output',
        `Node ${nodeId} produced prompt output`,
        { output: capturedOutput },
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
