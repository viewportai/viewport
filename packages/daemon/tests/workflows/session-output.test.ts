import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readCodexWorktreeSessionOutput,
  readCodexWorktreeSessionTranscriptExcerpt,
  transcriptExcerptFromRichMessages,
} from '../../src/workflows/session-output.js';

let tempHome: string | undefined;
const originalCodexHome = process.env['CODEX_HOME'];

describe('workflow session output helpers', () => {
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

  it('builds bounded transcript excerpts from rich text messages', () => {
    const excerpt = transcriptExcerptFromRichMessages(
      [
        { kind: 'text', role: 'user', text: 'first request', ts: '1', uuid: '1' },
        { kind: 'tool_use', toolName: 'Bash', toolId: 'tool-1', input: {}, ts: '2', uuid: '2' },
        { kind: 'text', role: 'assistant', text: 'first response', ts: '3', uuid: '3' },
        { kind: 'text', role: 'user', text: 'second request', ts: '4', uuid: '4' },
        {
          kind: 'text',
          role: 'assistant',
          text: 'x'.repeat(20),
          ts: '5',
          uuid: '5',
        },
      ],
      { maxMessages: 3, maxCharsPerMessage: 8 },
    );

    expect(excerpt).toEqual([
      { role: 'assistant', text: 'first re...' },
      { role: 'user', text: 'second r...' },
      { role: 'assistant', text: 'xxxxxxxx...' },
    ]);
  });

  it('recovers Codex transcript output from the matching session id in a shared worktree', async () => {
    const worktreePath = await setupCodexHome();
    await writeCodexTranscript({
      sessionId: 'other-session',
      cwd: worktreePath,
      output: 'newer but wrong',
      timestamp: '2026-04-24T10:01:00.000Z',
    });
    await writeCodexTranscript({
      sessionId: 'target-session',
      cwd: worktreePath,
      output: 'target output',
      timestamp: '2026-04-24T10:00:00.000Z',
    });

    await expect(readCodexWorktreeSessionOutput(worktreePath, ['target-session'])).resolves.toBe(
      'target output',
    );
    await expect(
      readCodexWorktreeSessionTranscriptExcerpt(worktreePath, ['target-session']),
    ).resolves.toEqual([{ role: 'assistant', text: 'target output' }]);
  });
});

async function setupCodexHome(): Promise<string> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-output-'));
  process.env['CODEX_HOME'] = tempHome;
  const worktreePath = path.join(tempHome, 'repo');
  await fs.mkdir(worktreePath, { recursive: true });
  return worktreePath;
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
