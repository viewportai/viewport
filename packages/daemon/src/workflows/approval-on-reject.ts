import type { Daemon } from '../core/daemon.js';
import { runWorkflowDaemonSession } from './daemon-session.js';
import { addEvent, renderTemplate, resolveNodeCwd, runShellNode } from './runtime-helpers.js';
import type { WorkflowSessionLinkStore } from './session-links.js';
import type { WorkflowShellAbortRegistry } from './shell-abort-registry.js';
import type { WorkflowApprovalNode, WorkflowRunRecord } from './types.js';

export interface ApprovalOnRejectContext {
  daemon: Daemon;
  sessionLinks: WorkflowSessionLinkStore;
  shellAbortRegistry: WorkflowShellAbortRegistry;
  saveAndEmit: (run: WorkflowRunRecord) => Promise<void>;
}

/**
 * Run the approval node's `onReject` follow-up after a denial. Output is
 * recorded on the workflow timeline, but follow-up failures never mask the
 * rejection itself because the run is canceling anyway.
 */
export async function runApprovalOnRejectFollowUp(
  context: ApprovalOnRejectContext,
  run: WorkflowRunRecord,
  nodeId: string,
  onReject: NonNullable<WorkflowApprovalNode['onReject']>,
  rejectionMessage: string | undefined,
): Promise<void> {
  if ('prompt' in onReject) {
    await runPromptFollowUp(context, run, nodeId, onReject);
    return;
  }

  await runShellFollowUp(context, run, nodeId, onReject, rejectionMessage);
}

async function runPromptFollowUp(
  context: ApprovalOnRejectContext,
  run: WorkflowRunRecord,
  nodeId: string,
  onReject: Extract<NonNullable<WorkflowApprovalNode['onReject']>, { prompt: string }>,
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;
  addEvent(
    run,
    'node-log',
    `Approval ${nodeId} rejected — running onReject prompt`,
    {
      prompt: onReject.prompt,
      ...(onReject.agent ? { agent: onReject.agent } : {}),
      ...(onReject.model ? { model: onReject.model } : {}),
    },
    nodeId,
  );
  await context.saveAndEmit(run);
  try {
    await runWorkflowDaemonSession(context, {
      run,
      nodeId,
      target: state,
      prompt: await renderTemplate(onReject.prompt, run),
      ...(onReject.agent ? { agent: onReject.agent } : {}),
      ...(onReject.model ? { model: onReject.model } : {}),
      ...(onReject.effort ? { effort: onReject.effort } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addEvent(
      run,
      'node-log',
      `onReject prompt for ${nodeId} errored: ${message}`,
      { error: message },
      nodeId,
    );
  }
}

async function runShellFollowUp(
  context: ApprovalOnRejectContext,
  run: WorkflowRunRecord,
  nodeId: string,
  onReject: Extract<NonNullable<WorkflowApprovalNode['onReject']>, { command: string }>,
  rejectionMessage: string | undefined,
): Promise<void> {
  const command = await renderTemplate(onReject.command, run);
  const cwd = resolveNodeCwd(
    run.directoryPath,
    onReject.cwd ? await renderTemplate(onReject.cwd, run) : undefined,
  );
  const abort = context.shellAbortRegistry.create(run.id, `approval-on-reject:${nodeId}`);
  addEvent(
    run,
    'node-log',
    `Approval ${nodeId} rejected — running onReject command`,
    { command, cwd },
    nodeId,
  );
  try {
    const result = await runShellNode(command, {
      cwd,
      timeoutSeconds: onReject.timeoutSeconds,
      signal: abort.signal,
      env: rejectionMessage ? { VIEWPORT_REJECT_MESSAGE: rejectionMessage } : undefined,
    });
    addEvent(
      run,
      'node-log',
      `onReject for ${nodeId} exited ${result.exitCode}`,
      { exitCode: result.exitCode, output: result.output },
      nodeId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addEvent(
      run,
      'node-log',
      `onReject for ${nodeId} errored: ${message}`,
      { error: message },
      nodeId,
    );
  } finally {
    abort.dispose();
  }
}
