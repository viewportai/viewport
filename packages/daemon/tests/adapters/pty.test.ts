import { describe, it, expect, afterEach } from 'vitest';
import _path from 'node:path';
import os from 'node:os';
import { PtyAdapter, PtySession } from '../../src/adapters/pty.js';
import type { SessionMessage } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// PtySession
// ---------------------------------------------------------------------------

describe('PtySession', () => {
  let session: PtySession | null = null;

  afterEach(async () => {
    if (session && session.state !== 'completed' && session.state !== 'errored') {
      await session.kill();
    }
    session = null;
  });

  it('creates a session with unique ID', () => {
    session = new PtySession('test-id');
    expect(session.id).toBe('test-id');
    expect(session.state).toBe('starting');
  });

  it('starts a process and transitions to running', async () => {
    session = new PtySession('test-start');
    const stateChanges: string[] = [];
    session.on('state-change', (state) => stateChanges.push(state));

    session.start('echo', ['hello world'], os.tmpdir());

    // Wait for process to finish
    await new Promise<void>((resolve) => session!.on('ended', () => resolve()));

    expect(stateChanges).toContain('running');
    expect(stateChanges).toContain('completed');
  });

  it('emits messages from stdout', async () => {
    session = new PtySession('test-stdout');
    const messages: SessionMessage[] = [];
    session.on('message', (msg) => messages.push(msg));

    session.start('echo', ['viewport test output'], os.tmpdir());

    await new Promise<void>((resolve) => session!.on('ended', () => resolve()));

    const textMessages = messages.filter(
      (m) => m.type === 'agent_message_chunk' || m.type === 'agent_message',
    );
    expect(textMessages.length).toBeGreaterThan(0);
    const allText = textMessages.map((m) => ('text' in m ? m.text : '')).join('');
    expect(allText).toContain('viewport test output');
  });

  it('reports errored state for non-zero exit code', async () => {
    session = new PtySession('test-error');
    const stateChanges: string[] = [];
    session.on('state-change', (state) => stateChanges.push(state));

    session.start('sh', ['-c', 'exit 1'], os.tmpdir());

    await new Promise<void>((resolve) => session!.on('ended', () => resolve()));

    expect(stateChanges).toContain('errored');
  });

  it('handles process not found', async () => {
    session = new PtySession('test-not-found');
    const stateChanges: string[] = [];
    session.on('state-change', (state) => stateChanges.push(state));

    session.start('nonexistent-binary-that-does-not-exist', [], os.tmpdir());

    await new Promise<void>((resolve) => session!.on('ended', () => resolve()));

    expect(stateChanges).toContain('errored');
  });

  it('can send prompt via stdin', async () => {
    session = new PtySession('test-stdin');
    const messages: SessionMessage[] = [];
    session.on('message', (msg) => messages.push(msg));

    // Start cat which reads from stdin and echoes to stdout
    session.start('cat', [], os.tmpdir());

    // Small delay for process to be ready
    await new Promise((r) => setTimeout(r, 100));

    await session.sendPrompt('hello from viewport');

    // Give some time for output
    await new Promise((r) => setTimeout(r, 300));

    // Should have a user_message
    const userMsgs = messages.filter((m) => m.type === 'user_message');
    expect(userMsgs.length).toBeGreaterThan(0);

    // Kill to clean up
    await session.kill();
  });

  it('can be killed', async () => {
    session = new PtySession('test-kill');

    // Register listener before start (start emits 'running' synchronously)
    const stateChanges: string[] = [];
    session.on('state-change', (state) => stateChanges.push(state));

    session.start('cat', [], os.tmpdir());

    // start() sets state to 'running' synchronously
    expect(stateChanges).toContain('running');

    // Kill sends SIGKILL and updates state immediately
    await session.kill();

    expect(session.state).toBe('errored');
    expect(stateChanges).toContain('errored');
  });
});

// ---------------------------------------------------------------------------
// PtyAdapter
// ---------------------------------------------------------------------------

describe('PtyAdapter', () => {
  it('creates adapter with agent ID', () => {
    const adapter = new PtyAdapter('test', 'echo');
    expect(adapter.agentId).toBe('test');
  });

  it('starts a session', async () => {
    const adapter = new PtyAdapter('echo-agent', 'echo', {
      promptMode: 'positional',
    });

    const session = await adapter.startSession(os.tmpdir(), {
      initialPrompt: 'hello',
    });

    expect(session.id).toBeDefined();

    await new Promise<void>((resolve) => session.on('ended', () => resolve()));
  });

  it('passes default args to process', async () => {
    const adapter = new PtyAdapter('test', 'echo', {
      defaultArgs: ['--flag1', '--flag2'],
      promptMode: 'positional',
    });

    const messages: SessionMessage[] = [];
    const session = await adapter.startSession(os.tmpdir(), {
      initialPrompt: 'hello',
    });

    session.on('message', (msg) => messages.push(msg));
    await new Promise<void>((resolve) => session.on('ended', () => resolve()));

    const allText = messages
      .filter((m) => m.type === 'agent_message_chunk' || m.type === 'agent_message')
      .map((m) => ('text' in m ? m.text : ''))
      .join('');

    // echo outputs all args
    expect(allText).toContain('--flag1');
    expect(allText).toContain('hello');
  });

  it('resumeSession starts a new session (no true resume for PTY)', async () => {
    const adapter = new PtyAdapter('echo-agent', 'echo');
    const session = await adapter.resumeSession('old-id', os.tmpdir());

    // Should get a new session, not the old one
    expect(session.id).not.toBe('old-id');

    await new Promise<void>((resolve) => session.on('ended', () => resolve()));
  });

  it('resumeSession uses resume args when configured', async () => {
    const adapter = new PtyAdapter('echo-agent', 'echo', {
      defaultArgs: ['--foo'],
      resumeArgs: ['--resume'],
      promptMode: 'positional',
    });
    const messages: SessionMessage[] = [];
    const session = await adapter.resumeSession('session-123', os.tmpdir(), {
      initialPrompt: 'continue work',
    });
    session.on('message', (msg) => messages.push(msg));
    await new Promise<void>((resolve) => session.on('ended', () => resolve()));

    const allText = messages
      .filter((m) => m.type === 'agent_message_chunk' || m.type === 'agent_message')
      .map((m) => ('text' in m ? m.text : ''))
      .join('');
    expect(allText).toContain('--resume');
    expect(allText).toContain('session-123');
    expect(allText).toContain('continue work');
  });

  it('bounds retained output buffer size', async () => {
    const adapter = new PtyAdapter('node-agent', 'node', {
      maxOutputBufferBytes: 2048,
      promptMode: 'positional',
    });
    const session = await adapter.startSession(os.tmpdir(), {
      initialPrompt: '-e process.stdout.write("x".repeat(20000))',
    });

    let finalMessageText = '';
    session.on('message', (msg) => {
      if (msg.type === 'agent_message') {
        finalMessageText = msg.text;
      }
    });
    await new Promise<void>((resolve) => session.on('ended', () => resolve()));

    expect(finalMessageText.length).toBeLessThanOrEqual(3000);
  });
});
