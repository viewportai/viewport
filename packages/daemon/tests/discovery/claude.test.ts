import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeDiscovery } from '../../src/discovery/claude.js';
import {
  decodeProjectDir,
  encodeProjectDir,
  listProjectSessions,
  parseJSONLEntry,
  readSessionMessages,
} from '../../src/discovery/jsonl-reader.js';

// ---------------------------------------------------------------------------
// JSONL reader unit tests
// ---------------------------------------------------------------------------

describe('jsonl-reader', () => {
  describe('path encoding', () => {
    it('encodes absolute path to directory name', () => {
      expect(encodeProjectDir('/Users/dev/myapp')).toBe('-Users-dev-myapp');
    });

    it('decodes directory name back to path', () => {
      expect(decodeProjectDir('-Users-dev-myapp')).toBe('/Users/dev/myapp');
    });

    it('roundtrips correctly', () => {
      const original = '/Users/dev/workspace/viewport';
      expect(decodeProjectDir(encodeProjectDir(original))).toBe(original);
    });
  });

  it('maps Codex app-server event messages into rich timeline blocks', () => {
    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          call_id: 'call-1',
          command: ['npm', 'test'],
          cwd: '/tmp/project',
          exit_code: 0,
          aggregated_output: 'tests passed',
          duration: { ms: 1234 },
        },
      }),
    ).toEqual([
      {
        kind: 'command',
        command: 'npm test',
        cwd: '/tmp/project',
        status: 'completed',
        exitCode: 0,
        output: 'tests passed',
        durationMs: 1234,
        ts: '2026-05-14T10:00:00.000Z',
        uuid: 'call-1',
      },
    ]);

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'exec_approval_request',
          call_id: 'call-2',
          command: ['git', 'push'],
          cwd: '/tmp/project',
          reason: 'Network access requires approval',
        },
      })[0],
    ).toMatchObject({
      kind: 'approval',
      title: 'Command approval needed',
      body: 'Network access requires approval\ngit push',
    });

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'future_provider_event',
          value: 'do not drop me',
        },
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Provider event: future_provider_event',
      body: '{"type":"future_provider_event","value":"do not drop me"}',
      tone: 'muted',
    });
  });

  it('maps Claude Bash and edit tool uses into first-class rich timeline blocks', () => {
    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:05:00.000Z',
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-bash-1',
              name: 'Bash',
              input: {
                command: 'npm run test -- --runInBand',
                cwd: '/tmp/project',
              },
            },
          ],
        },
      }),
    ).toEqual([
      {
        kind: 'command',
        command: 'npm run test -- --runInBand',
        cwd: '/tmp/project',
        status: 'started',
        ts: '2026-05-14T10:05:00.000Z',
        uuid: 'toolu-bash-1',
      },
    ]);

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:05:01.000Z',
        type: 'assistant',
        uuid: 'assistant-2',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-edit-1',
              name: 'Edit',
              input: {
                file_path: '/tmp/project/src/session.ts',
              },
            },
          ],
        },
      }),
    ).toEqual([
      {
        kind: 'file_change',
        path: '/tmp/project/src/session.ts',
        operation: 'Edit',
        ts: '2026-05-14T10:05:01.000Z',
        uuid: 'toolu-edit-1',
      },
    ]);
  });

  it('surfaces Viewport CLI JSON outputs as product timeline events', () => {
    const blocks = parseJSONLEntry({
      timestamp: '2026-05-14T10:10:00.000Z',
      type: 'user',
      uuid: 'tool-result-context',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-context-propose',
            content: JSON.stringify({
              schema_version: 'viewport.cli.context_propose/v1',
              command: 'context propose',
              ok: true,
              provider_id: 'team_memory',
              provider: 'viewport-vault',
              status: 'pending_review',
              candidate_id: 'evt_context_1',
              payload_digest: 'sha256:abc123',
              message: 'Context candidate queued for human review.',
            }),
          },
        ],
      },
    });

    expect(blocks[0]).toMatchObject({
      kind: 'tool_result',
      toolId: 'toolu-context-propose',
    });
    expect(blocks[1]).toMatchObject({
      kind: 'event',
      title: 'Context candidate proposed',
      body: 'candidate evt_context_1\nprovider team_memory\nstatus pending_review\nsha256:abc123',
      tone: 'warning',
    });
  });

  it('surfaces explicit Viewport plan blocks as product timeline events without exposing plan body', () => {
    const blocks = parseJSONLEntry({
      timestamp: '2026-05-14T10:15:00.000Z',
      type: 'assistant',
      uuid: 'assistant-plan-block',
      message: {
        content: [
          {
            type: 'text',
            text: [
              'Here is the plan.',
              '```viewport-plan',
              JSON.stringify({
                schema: 'viewport.plan_proposal/v1',
                title: 'Migrate sessions UI',
                summary: 'Make sessions match native provider behavior.',
                body: 'Sensitive long plan body should stay in the normal transcript text.',
              }),
              '```',
            ].join('\n'),
          },
        ],
      },
    });

    expect(blocks[0]).toMatchObject({
      kind: 'text',
      role: 'assistant',
    });
    expect(blocks[1]).toMatchObject({
      kind: 'event',
      title: 'Plan draft emitted: Migrate sessions UI',
      body: 'Make sessions match native provider behavior.',
      tone: 'warning',
    });
    expect(blocks[1]).not.toMatchObject({
      body: expect.stringContaining('Sensitive long plan body'),
    });
  });

  it('keeps Claude lifecycle metadata visible without rendering injected environment noise', () => {
    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:20:00.000Z',
        type: 'summary',
        uuid: 'summary-1',
        summary: 'User asked to compact before continuing.',
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Conversation compacted',
      body: 'User asked to compact before continuing.',
      tone: 'muted',
    });

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:21:00.000Z',
        type: 'future-claude-event',
        uuid: 'future-1',
        value: 'keep visible',
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Provider event: future-claude-event',
      body: '{"timestamp":"2026-05-14T10:21:00.000Z","type":"future-claude-event","uuid":"future-1","value":"keep visible"}',
      tone: 'muted',
    });

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:22:00.000Z',
        type: 'system',
        uuid: 'system-env',
        content: '<environment_context><cwd>/tmp/project</cwd></environment_context>',
      }),
    ).toEqual([]);
  });

  it('filters Claude local command wrappers into quiet command events', () => {
    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:25:00.000Z',
        type: 'user',
        uuid: 'local-caveat',
        message: {
          content:
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
        },
      }),
    ).toEqual([]);

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:25:01.000Z',
        type: 'user',
        uuid: 'slash-model',
        message: {
          content: [
            {
              type: 'text',
              text: [
                '<command-name>/model</command-name>',
                '<command-message>model</command-message>',
                '<command-args></command-args>',
              ].join('\n'),
            },
          ],
        },
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Claude command: /model',
      body: 'model',
      tone: 'muted',
    });

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:25:02.000Z',
        type: 'user',
        uuid: 'slash-output',
        message: {
          content:
            '<local-command-stdout>Set model to \u001b[1mHaiku 4.5\u001b[22m</local-command-stdout>',
        },
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Claude command output',
      body: 'Set model to Haiku 4.5',
      tone: 'muted',
    });

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:25:03.000Z',
        type: 'user',
        uuid: 'task-note',
        message: {
          content: '<task-notification>Task completed by Explore agent</task-notification>',
        },
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Claude task notification',
      body: 'Task completed by Explore agent',
      tone: 'muted',
    });
  });

  it('maps Claude subagent and task tools into readable events', () => {
    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:26:00.000Z',
        type: 'assistant',
        uuid: 'agent-tool',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-agent',
              name: 'Agent',
              input: {
                subagent_type: 'Explore',
                description: 'Survey current auth implementation',
                prompt: 'Survey the current authentication implementation.\nReturn file paths.',
              },
            },
          ],
        },
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'Subagent started: Explore',
      body: 'Survey current auth implementation\nSurvey the current authentication implementation.',
      tone: 'muted',
    });

    expect(
      parseJSONLEntry({
        timestamp: '2026-05-14T10:26:01.000Z',
        type: 'assistant',
        uuid: 'task-tool',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-task',
              name: 'TaskCompleted',
              input: {
                task_subject: 'Audit session rendering',
                task_description: 'Subagent finished parser review.',
              },
            },
          ],
        },
      })[0],
    ).toMatchObject({
      kind: 'event',
      title: 'TaskCompleted: Audit session rendering',
      body: 'Subagent finished parser review.',
      tone: 'success',
    });
  });
});

// ---------------------------------------------------------------------------
// JSONL reader with real temp files
// ---------------------------------------------------------------------------

describe('jsonl-reader with temp files', () => {
  let tmpProjectsDir: string;

  beforeEach(async () => {
    // Create a temp directory that mimics ~/.claude/projects/
    tmpProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpProjectsDir, { recursive: true, force: true });
  });

  async function writeJsonl(dirName: string, sessionId: string, lines: unknown[]): Promise<void> {
    const dir = path.join(tmpProjectsDir, dirName);
    await fs.mkdir(dir, { recursive: true });
    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), content, 'utf-8');
  }

  function makeUserMessage(text: string, sessionId: string, timestamp: string) {
    return {
      type: 'user',
      sessionId,
      cwd: '/tmp/test-project',
      timestamp,
      uuid: `uuid-${Math.random().toString(36).slice(2)}`,
      message: { content: [{ type: 'text', text }] },
    };
  }

  function makeAssistantMessage(text: string, sessionId: string, timestamp: string) {
    return {
      type: 'assistant',
      sessionId,
      cwd: '/tmp/test-project',
      timestamp,
      uuid: `uuid-${Math.random().toString(36).slice(2)}`,
      message: { content: [{ type: 'text', text }] },
    };
  }

  it('parses session summary from JSONL', async () => {
    const dirName = '-tmp-test-project';
    await writeJsonl(dirName, 'session-1', [
      makeUserMessage('Fix the login bug', 'session-1', '2026-01-01T10:00:00Z'),
      makeAssistantMessage('I will fix the login bug.', 'session-1', '2026-01-01T10:00:05Z'),
      makeUserMessage('Also update the tests', 'session-1', '2026-01-01T10:01:00Z'),
      makeAssistantMessage('Done.', 'session-1', '2026-01-01T10:01:05Z'),
    ]);

    const sessions = await listProjectSessions(dirName, tmpProjectsDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe('session-1');
    expect(sessions[0]!.summary).toBe('Fix the login bug');
    expect(sessions[0]!.messageCount).toBe(4);
    expect(sessions[0]!.cwd).toBe('/tmp/test-project');
    expect(sessions[0]!.resumable).toBe(true);
  });

  it('prefers Claude native custom titles over first prompt display titles', async () => {
    const dirName = '-tmp-test-project';
    await writeJsonl(dirName, 'session-title', [
      makeUserMessage('Please fix the auth retry flow', 'session-title', '2026-01-01T10:00:00Z'),
      {
        type: 'custom-title',
        sessionId: 'session-title',
        customTitle: 'Auth Retry Cleanup',
        timestamp: '2026-01-01T10:00:03Z',
      },
      makeAssistantMessage('I will inspect it.', 'session-title', '2026-01-01T10:00:05Z'),
    ]);

    const sessions = await listProjectSessions(dirName, tmpProjectsDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      summary: 'Please fix the auth retry flow',
      nativeTitle: 'Auth Retry Cleanup',
      displayTitle: 'Auth Retry Cleanup',
      titleSource: 'native',
      firstPrompt: 'Please fix the auth retry flow',
      lastPrompt: 'Please fix the auth retry flow',
    });
  });

  it('ignores injected environment metadata when deriving Claude titles', async () => {
    const dirName = '-tmp-test-project';
    await writeJsonl(dirName, 'session-env', [
      makeUserMessage(
        '<environment_context><cwd>/tmp/test-project</cwd><shell>zsh</shell></environment_context>',
        'session-env',
        '2026-01-01T10:00:00Z',
      ),
      makeUserMessage('Implement the session parity view', 'session-env', '2026-01-01T10:01:00Z'),
    ]);

    const sessions = await listProjectSessions(dirName, tmpProjectsDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe('Implement the session parity view');
    expect(sessions[0]?.displayTitle).toBe('Implement the session parity view');
    expect(sessions[0]?.titleSource).toBe('first_prompt');
  });

  it('reads full session messages', async () => {
    const dirName = '-tmp-test-project';
    await writeJsonl(dirName, 'session-2', [
      { type: 'progress', sessionId: 'session-2', cwd: '/tmp/test-project' },
      makeUserMessage('Hello', 'session-2', '2026-01-01T10:00:00Z'),
      makeAssistantMessage('Hi there!', 'session-2', '2026-01-01T10:00:01Z'),
    ]);

    const messages = await readSessionMessages(dirName, 'session-2', tmpProjectsDir);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.type).toBe('user');
    expect(messages[0]!.text).toBe('Hello');
    expect(messages[1]!.type).toBe('assistant');
    expect(messages[1]!.text).toBe('Hi there!');
  });

  it('skips malformed lines', async () => {
    const dirName = '-tmp-test-project';
    const dir = path.join(tmpProjectsDir, dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'session-3.jsonl'),
      'not valid json\n' +
        JSON.stringify(makeUserMessage('Hello', 'session-3', '2026-01-01T10:00:00Z')) +
        '\n',
      'utf-8',
    );

    const sessions = await listProjectSessions(dirName, tmpProjectsDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(1);
  });

  it('truncates long summaries to 120 characters', async () => {
    const longText = 'A'.repeat(200);
    const dirName = '-tmp-test-project';
    await writeJsonl(dirName, 'session-4', [
      makeUserMessage(longText, 'session-4', '2026-01-01T10:00:00Z'),
    ]);

    const sessions = await listProjectSessions(dirName, tmpProjectsDir);
    expect(sessions[0]!.summary).toHaveLength(120);
  });

  it('returns empty for missing directory', async () => {
    const sessions = await listProjectSessions('nonexistent-dir');
    expect(sessions).toEqual([]);
  });

  it('sorts sessions by last activity (most recent first)', async () => {
    const dirName = '-tmp-test-project';
    await writeJsonl(dirName, 'old-session', [
      makeUserMessage('Old', 'old-session', '2025-01-01T10:00:00Z'),
    ]);
    await writeJsonl(dirName, 'new-session', [
      makeUserMessage('New', 'new-session', '2026-06-01T10:00:00Z'),
    ]);

    const sessions = await listProjectSessions(dirName, tmpProjectsDir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.sessionId).toBe('new-session');
    expect(sessions[1]!.sessionId).toBe('old-session');
  });
});

// ---------------------------------------------------------------------------
// ClaudeDiscovery integration
// ---------------------------------------------------------------------------

describe('ClaudeDiscovery', () => {
  it('has agentId of "claude"', () => {
    const discovery = new ClaudeDiscovery();
    expect(discovery.agentId).toBe('claude');
  });

  it('returns empty for non-existent project', async () => {
    const discovery = new ClaudeDiscovery();
    const sessions = await discovery.discoverSessions('/nonexistent/path/that/does/not/exist');
    expect(sessions).toEqual([]);
  });
});
