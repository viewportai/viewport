import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPromptNodeOutput,
  readPromptNodeTranscriptExcerpt,
} from '../../src/workflows/prompt-output.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';

let tempHome: string | undefined;
const originalCodexHome = process.env['CODEX_HOME'];

describe('workflow prompt output recovery', () => {
  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = originalCodexHome;
    }

    if (!tempHome) return;
    await fs.rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('falls back to the registered directory when a prompt transcript is not under the worktree cwd', async () => {
    const projectPath = await setupCodexHome();
    const worktreePath = path.join(projectPath, '.viewport', 'worktrees', 'workflow-session');
    await fs.mkdir(worktreePath, { recursive: true });
    await writeCodexTranscript({
      sessionId: 'native-session',
      cwd: projectPath,
      output: 'recovered from parent repo transcript',
      timestamp: '2026-04-24T10:00:00.000Z',
    });

    const run = workflowRun(projectPath, worktreePath);
    const node = run.nodes['review']!;

    await expect(readPromptNodeOutput(run, node)).resolves.toBe(
      'recovered from parent repo transcript',
    );
    await expect(readPromptNodeTranscriptExcerpt(run, node)).resolves.toEqual([
      { role: 'assistant', text: 'recovered from parent repo transcript' },
    ]);
  });
});

async function setupCodexHome(): Promise<string> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-prompt-output-'));
  process.env['CODEX_HOME'] = tempHome;
  const projectPath = path.join(tempHome, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  return projectPath;
}

async function writeCodexTranscript({
  sessionId,
  cwd,
  output,
  timestamp,
}: {
  sessionId: string;
  cwd: string;
  output: string;
  timestamp: string;
}): Promise<void> {
  const root = path.join(process.env['CODEX_HOME']!, 'sessions', '2026', '04', '24');
  await fs.mkdir(root, { recursive: true });
  const lines = [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd,
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: output }],
      },
    },
  ];
  await fs.writeFile(
    path.join(root, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf-8',
  );
}

function workflowRun(projectPath: string, worktreePath: string): WorkflowRunRecord {
  return {
    id: 'run-1',
    workflowName: 'team/pr-review',
    workflowTitle: 'Pull request review',
    sourceType: 'viewport_snapshot',
    digest: 'sha256:run',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: team/pr-review\nnodes: {}\n',
    directoryId: 'dir-1',
    directoryPath: projectPath,
    machineId: 'machine-1',
    initiation: 'browser',
    status: 'completed',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {
      review: {
        id: 'review',
        type: 'prompt',
        title: 'Review',
        status: 'completed',
        sessionId: 'workflow-session',
        nativeSessionId: 'native-session',
        worktreePath,
      },
    },
    artifacts: [],
    events: [],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}
