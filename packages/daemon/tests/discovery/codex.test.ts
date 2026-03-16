import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexDiscovery, codexSessionsDir } from '../../src/discovery/codex.js';

describe('CodexDiscovery', () => {
  let tempHome: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-discovery-'));
    originalCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = tempHome;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = originalCodexHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('discovers project sessions from json files', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-project-'));
    const sessionsDir = codexSessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const payload = {
      threadId: 'thread-1',
      cwd: projectPath,
      updatedAt: '2026-03-01T12:00:00Z',
      messages: [
        { role: 'user', content: 'Fix the flaky test' },
        { role: 'assistant', content: 'I will inspect the tests first.' },
      ],
    };
    await fs.writeFile(path.join(sessionsDir, 'thread-1.json'), JSON.stringify(payload), 'utf-8');

    const discovery = new CodexDiscovery();
    const sessions = await discovery.discoverSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agentId: 'codex',
      sessionId: 'thread-1',
      summary: 'Fix the flaky test',
      cwd: projectPath,
      resumable: true,
      messageCount: 2,
    });

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('filters out sessions from other directories', async () => {
    const sessionsDir = codexSessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'thread-other.json'),
      JSON.stringify({
        threadId: 'thread-other',
        cwd: '/tmp/somewhere-else',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      'utf-8',
    );

    const discovery = new CodexDiscovery();
    const sessions = await discovery.discoverSessions('/tmp/target-project');
    expect(sessions).toEqual([]);
  });

  it('discovers jsonl sessions with payload cwd and session_meta id', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-project-jsonl-'));
    const sessionsDir = path.join(codexSessionsDir(), '2026', '03', '02');
    await fs.mkdir(sessionsDir, { recursive: true });

    const filePath = path.join(sessionsDir, 'rollout-2026-03-02T12-06-51-abc.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-03-02T17:07:37.196Z',
          type: 'session_meta',
          payload: {
            id: '019caf84-544d-78e1-a625-e781b4268523',
            timestamp: '2026-03-02T17:06:51.086Z',
            cwd: projectPath,
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'stream codex messages while typing' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-02T17:07:37.199Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'working on it' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const discovery = new CodexDiscovery();
    const sessions = await discovery.discoverSessions(projectPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agentId: 'codex',
      sessionId: '019caf84-544d-78e1-a625-e781b4268523',
      summary: 'stream codex messages while typing',
      cwd: projectPath,
      resumable: true,
      messageCount: 2,
      sourcePath: filePath,
    });

    await fs.rm(projectPath, { recursive: true, force: true });
  });
});
