import path from 'node:path';
import { readCodexWorktreeSessionOutput, readPersistedSessionOutput } from './session-output.js';
import type { WorkflowNodeRunState, WorkflowRunRecord } from './types.js';

export async function readPromptNodeOutput(
  run: WorkflowRunRecord,
  node: WorkflowNodeRunState,
): Promise<string> {
  if (!node.sessionId) return '';

  const persisted = readPersistedSessionOutput(node.sessionId);
  if (persisted) return persisted;

  const nativePersisted = node.nativeSessionId
    ? readPersistedSessionOutput(node.nativeSessionId)
    : '';
  if (nativePersisted) return nativePersisted;

  const worktreePath = node.worktreePath ?? defaultWorktreePath(run, node.sessionId);
  try {
    return await readCodexWorktreeSessionOutput(worktreePath);
  } catch {
    return '';
  }
}

export function defaultWorktreePath(run: WorkflowRunRecord, sessionId: string): string {
  return path.join(run.directoryPath, '.viewport', 'worktrees', sessionId);
}
