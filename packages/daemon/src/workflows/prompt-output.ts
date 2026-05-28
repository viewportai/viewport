import path from 'node:path';
import {
  readCodexWorktreeSessionOutput,
  readCodexWorktreeSessionTranscriptExcerpt,
  readPersistedSessionOutput,
  readPersistedSessionTranscriptExcerpt,
  type TranscriptExcerptMessage,
} from './session-output.js';
import type { WorkflowNodeRunState, WorkflowRunRecord } from './types.js';

export async function readPromptNodeOutput(
  run: WorkflowRunRecord,
  node: WorkflowNodeRunState,
  options: { allowCodexDiscovery?: boolean } = {},
): Promise<string> {
  if (!node.sessionId) return '';

  const persisted = readPersistedSessionOutput(node.sessionId);
  if (persisted) return persisted;

  const nativePersisted = node.nativeSessionId
    ? readPersistedSessionOutput(node.nativeSessionId)
    : '';
  if (nativePersisted) return nativePersisted;

  const sessionIds = [node.sessionId, node.nativeSessionId].filter((id): id is string =>
    Boolean(id),
  );
  if (options.allowCodexDiscovery === false || !nodeUsesCodexDiscovery(node)) {
    return '';
  }
  for (const candidatePath of outputCandidatePaths(run, node)) {
    try {
      const output = await readCodexWorktreeSessionOutput(candidatePath, sessionIds);
      if (output) return output;
    } catch {
      // Try the next plausible cwd. Agent adapters are not yet perfectly
      // consistent about whether transcript cwd is the worktree or parent repo.
    }
  }
  return '';
}

export async function readPromptNodeTranscriptExcerpt(
  run: WorkflowRunRecord,
  node: WorkflowNodeRunState,
  options: { allowCodexDiscovery?: boolean } = {},
): Promise<TranscriptExcerptMessage[]> {
  if (!node.sessionId) return [];

  const persisted = readPersistedSessionTranscriptExcerpt(node.sessionId);
  if (persisted.length > 0) return persisted;

  const nativePersisted = node.nativeSessionId
    ? readPersistedSessionTranscriptExcerpt(node.nativeSessionId)
    : [];
  if (nativePersisted.length > 0) return nativePersisted;

  const sessionIds = [node.sessionId, node.nativeSessionId].filter((id): id is string =>
    Boolean(id),
  );
  if (options.allowCodexDiscovery === false || !nodeUsesCodexDiscovery(node)) {
    return [];
  }
  for (const candidatePath of outputCandidatePaths(run, node)) {
    try {
      const excerpt = await readCodexWorktreeSessionTranscriptExcerpt(candidatePath, sessionIds);
      if (excerpt.length > 0) return excerpt;
    } catch {
      // Try the next plausible cwd.
    }
  }
  return [];
}

export function defaultWorktreePath(run: WorkflowRunRecord, sessionId: string): string {
  return path.join(run.directoryPath, '.viewport', 'worktrees', sessionId);
}

function outputCandidatePaths(run: WorkflowRunRecord, node: WorkflowNodeRunState): string[] {
  if (!node.sessionId) return [];
  return uniquePaths([
    node.worktreePath,
    defaultWorktreePath(run, node.sessionId),
    run.directoryPath,
  ]);
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawPath of paths) {
    if (!rawPath) continue;
    const resolvedPath = path.resolve(rawPath);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    out.push(resolvedPath);
  }
  return out;
}

function nodeUsesCodexDiscovery(node: WorkflowNodeRunState): boolean {
  const agent = node.metadata?.['agent'];
  if (typeof agent === 'string') return agent === 'codex';

  const provider = node.metadata?.['provider'];
  if (typeof provider === 'string') return provider === 'codex';

  return false;
}
