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

    const discovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
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

  it('prefers Codex native thread names and captures session settings', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-title-project-'));
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '22');
    await fs.mkdir(sessionsDir, { recursive: true });

    const filePath = path.join(sessionsDir, 'rollout-native-title.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-04-22T17:07:37.196Z',
          type: 'session_meta',
          payload: {
            id: 'codex-native-title',
            cwd: projectPath,
            thread_name: 'Multi DB Migration Plan',
            model: 'gpt-5.3-codex',
            approval_policy: 'on-request',
            sandbox_mode: 'workspace-write',
            model_reasoning_effort: 'high',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-22T17:07:37.198Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'plan a database tenancy migration' },
        }),
        JSON.stringify({
          timestamp: '2026-04-22T17:07:38.198Z',
          type: 'event_msg',
          payload: {
            type: 'thread_name_updated',
            thread_id: 'codex-native-title',
            thread_name: 'Tenant Database Cutover',
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const discovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
    const sessions = await discovery.discoverSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nativeTitle: 'Tenant Database Cutover',
      displayTitle: 'Tenant Database Cutover',
      titleSource: 'native',
      firstPrompt: 'plan a database tenancy migration',
      latestModel: 'gpt-5.3-codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      reasoningEffort: 'high',
    });

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('uses Codex session_index thread names when rollout history has no title event', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-index-project-'));
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '23');
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(tempHome, 'session_index.jsonl'),
      JSON.stringify({
        id: 'codex-index-title',
        thread_name: 'Indexed Codex Session Name',
        updated_at: '2026-04-23T17:00:00Z',
      }) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(sessionsDir, 'rollout-index-title.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-23T17:07:37.196Z',
          type: 'session_meta',
          payload: { id: 'codex-index-title', cwd: projectPath },
        }),
        JSON.stringify({
          timestamp: '2026-04-23T17:07:37.198Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'fallback prompt' },
        }),
      ].join('\n'),
      'utf-8',
    );

    const discovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
    const sessions = await discovery.discoverSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      nativeTitle: 'Indexed Codex Session Name',
      displayTitle: 'Indexed Codex Session Name',
      titleSource: 'native',
      firstPrompt: 'fallback prompt',
    });

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('does not use injected environment metadata as the session summary', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-project-jsonl-'));
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '19');
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(sessionsDir, 'rollout-env-context.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-19T17:07:37.196Z',
          type: 'session_meta',
          payload: {
            id: 'codex-env-session',
            cwd: projectPath,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-19T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<environment_context><cwd>/Users/mehr/Herd/viewportai</cwd><shell>zsh</shell><current_date>2026-04-19</current_date></environment_context>',
              },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const discovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
    const sessions = await discovery.discoverSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe('Codex session');

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('skips placeholder summaries and uses the first meaningful user message', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-project-jsonl-'));
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '20');
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(sessionsDir, 'rollout-placeholder-context.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-20T17:07:37.196Z',
          type: 'session_meta',
          payload: {
            id: 'codex-placeholder-session',
            cwd: projectPath,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-20T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: '<environment_context><cwd>/Users/mehr/Herd/viewportai</cwd><shell>zsh</shell></environment_context>',
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-20T17:07:38.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'none' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-20T17:07:39.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the session transcript rendering' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const discovery = new CodexDiscovery();
    const sessions = await discovery.discoverSessions(projectPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe('Fix the session transcript rendering');

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('refreshes cached discovery when a session file changes after the reuse window expires', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-codex-cache-project-'));
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '21');
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'rollout-cache.jsonl');

    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: '2026-04-21T17:07:37.196Z',
          type: 'session_meta',
          payload: { id: 'codex-cache-session', cwd: projectPath },
        }),
        JSON.stringify({
          timestamp: '2026-04-21T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Initial prompt' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const discovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
    expect((await discovery.discoverSessions(projectPath))[0]?.messageCount).toBe(1);

    await fs.appendFile(
      filePath,
      JSON.stringify({
        timestamp: '2026-04-21T17:07:38.198Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Second message' }],
        },
      }) + '\n',
      'utf-8',
    );
    const bumped = new Date(Date.now() + 2_000);
    await fs.utimes(filePath, bumped, bumped);

    const refreshed = await discovery.discoverSessions(projectPath);
    expect(refreshed[0]?.messageCount).toBe(2);

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('refreshes cached discovery when an older non-newest session file changes after the reuse window expires', async () => {
    const projectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'viewport-codex-cache-older-project-'),
    );
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '22');
    await fs.mkdir(sessionsDir, { recursive: true });
    const olderFile = path.join(sessionsDir, 'rollout-older.jsonl');
    const newerFile = path.join(sessionsDir, 'rollout-newer.jsonl');

    await fs.writeFile(
      olderFile,
      [
        JSON.stringify({
          timestamp: '2026-04-22T17:07:37.196Z',
          type: 'session_meta',
          payload: { id: 'codex-older-session', cwd: projectPath },
        }),
        JSON.stringify({
          timestamp: '2026-04-22T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Older prompt' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    await fs.writeFile(
      newerFile,
      [
        JSON.stringify({
          timestamp: '2026-04-22T17:08:37.196Z',
          type: 'session_meta',
          payload: { id: 'codex-newer-session', cwd: projectPath },
        }),
        JSON.stringify({
          timestamp: '2026-04-22T17:08:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Newer prompt' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const olderTime = new Date(Date.now() - 10_000);
    const newerTime = new Date(Date.now());
    await fs.utimes(olderFile, olderTime, olderTime);
    await fs.utimes(newerFile, newerTime, newerTime);

    const discovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
    const first = await discovery.discoverSessions(projectPath);
    expect(first.find((session) => session.sessionId === 'codex-older-session')?.messageCount).toBe(
      1,
    );

    await fs.appendFile(
      olderFile,
      JSON.stringify({
        timestamp: '2026-04-22T17:07:38.198Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Older follow-up' }],
        },
      }) + '\n',
      'utf-8',
    );
    const stillOlderTime = new Date(Date.now() - 5_000);
    await fs.utimes(olderFile, stillOlderTime, stillOlderTime);
    await fs.utimes(newerFile, newerTime, newerTime);

    const refreshed = await discovery.discoverSessions(projectPath);
    expect(
      refreshed.find((session) => session.sessionId === 'codex-older-session')?.messageCount,
    ).toBe(2);

    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('reuses the parsed Codex tree across immediate directory lookups', async () => {
    const firstProjectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'viewport-codex-cache-first-project-'),
    );
    const secondProjectPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'viewport-codex-cache-second-project-'),
    );
    const sessionsDir = path.join(codexSessionsDir(), '2026', '04', '23');
    await fs.mkdir(sessionsDir, { recursive: true });
    const firstFile = path.join(sessionsDir, 'rollout-cache-first.jsonl');
    const secondFile = path.join(sessionsDir, 'rollout-cache-second.jsonl');

    await fs.writeFile(
      firstFile,
      [
        JSON.stringify({
          timestamp: '2026-04-23T17:07:37.196Z',
          type: 'session_meta',
          payload: { id: 'codex-cache-first-session', cwd: firstProjectPath },
        }),
        JSON.stringify({
          timestamp: '2026-04-23T17:07:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First project prompt' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const discovery = new CodexDiscovery();
    expect(await discovery.discoverSessions(firstProjectPath)).toHaveLength(1);

    await fs.writeFile(
      secondFile,
      [
        JSON.stringify({
          timestamp: '2026-04-23T17:08:37.196Z',
          type: 'session_meta',
          payload: { id: 'codex-cache-second-session', cwd: secondProjectPath },
        }),
        JSON.stringify({
          timestamp: '2026-04-23T17:08:37.198Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Second project prompt' }],
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    expect(await discovery.discoverSessions(secondProjectPath)).toEqual([]);

    const uncachedDiscovery = new CodexDiscovery({ parsedCacheReuseMs: 0 });
    expect(await uncachedDiscovery.discoverSessions(secondProjectPath)).toHaveLength(1);

    await fs.rm(firstProjectPath, { recursive: true, force: true });
    await fs.rm(secondProjectPath, { recursive: true, force: true });
  });
});
