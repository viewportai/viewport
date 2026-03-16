import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeDiscovery } from '../../src/discovery/claude.js';
import {
  decodeProjectDir,
  encodeProjectDir,
  listProjectSessions,
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
