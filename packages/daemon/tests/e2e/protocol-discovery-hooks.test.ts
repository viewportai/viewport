import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolHarness } from './support/protocol-harness.js';
import { FakeAdapter, StaticDiscovery } from './support/fake-agent.js';

describe('protocol e2e: discovery and hooks', () => {
  let harness: ProtocolHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it('aggregates discovery across claude/codex/gemini and serves list-sessions', async () => {
    const claudeDiscovery = new StaticDiscovery('claude');
    const codexDiscovery = new StaticDiscovery('codex');
    const geminiDiscovery = new StaticDiscovery('gemini');

    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude'), new FakeAdapter('codex'), new FakeAdapter('gemini')],
      discoveries: [claudeDiscovery, codexDiscovery, geminiDiscovery],
    });

    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);

    const now = Date.now();
    claudeDiscovery.setProjectSessions(projectPath, [
      {
        agentId: 'claude',
        sessionId: 'claude-1',
        summary: 'Fix lint',
        lastModified: now - 100,
        resumable: true,
      },
    ]);
    codexDiscovery.setProjectSessions(projectPath, [
      {
        agentId: 'codex',
        sessionId: 'codex-1',
        summary: 'Refactor parser',
        lastModified: now - 50,
        resumable: true,
      },
    ]);
    geminiDiscovery.setProjectSessions(projectPath, [
      {
        agentId: 'gemini',
        sessionId: 'gemini-1',
        summary: 'Add tests',
        lastModified: now,
        resumable: true,
      },
      {
        agentId: 'gemini',
        sessionId: 'gemini-old',
        summary: 'Older local history',
        lastModified: now - 25 * 60 * 60 * 1000,
        resumable: true,
      },
    ]);
    const client = await harness.connectClient();
    await client.waitForType('hello');

    await harness.runDiscoveryBroadcast();
    const update = await client.waitForType('discovered-sessions-updated');
    const announced = update['sessions'] as Array<Record<string, unknown>>;
    expect(announced.map((session) => session['id'])).not.toContain('gemini-old');

    client.send({
      type: 'list-sessions',
      directoryId: directory.id,
      requestId: 'list-1',
    });

    const list = await client.waitForType('session-list');
    const sessions = list['sessions'] as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(4);

    const agentIds = sessions.map((s) => String(s['agentId']));
    expect(new Set(agentIds)).toEqual(new Set(['claude', 'codex', 'gemini']));
    expect(sessions.map((session) => session['id'])).toContain('gemini-old');

    const ack = await client.waitForAck('list-1');
    expect(ack['status']).toBe('ok');

    client.close();
  });

  it('routes discovered tail updates only to watchers and broadcasts waiting events', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
    });

    const watcher = await harness.connectClient();
    const passive = await harness.connectClient();
    await watcher.waitForType('hello');
    await passive.waitForType('hello');

    watcher.send({
      type: 'watch-discovered-session',
      sessionId: 'disc-1',
      directoryId: 'dir-1',
      requestId: 'watch-1',
    });
    const watchAck = await watcher.waitForAck('watch-1');
    expect(watchAck['status']).toBe('ok');

    harness.daemon.emit('discovery:session-tail', {
      sessionId: 'disc-1',
      directoryId: 'dir-2',
      newBlocks: [
        {
          role: 'user',
          content: 'wrong directory',
          timestamp: Date.now(),
          uuid: 'b0',
        },
      ],
    });

    await expect(watcher.nextMessage(250)).rejects.toThrow('Timeout waiting for message');

    harness.daemon.emit('discovery:session-tail', {
      sessionId: 'disc-1',
      directoryId: 'dir-1',
      newBlocks: [
        {
          role: 'user',
          content: 'tail block',
          timestamp: Date.now(),
          uuid: 'b1',
        },
      ],
    });

    const watcherTail = await watcher.waitForType('discovered-session-tail');
    expect(watcherTail['sessionId']).toBe('disc-1');

    await expect(passive.nextMessage(250)).rejects.toThrow('Timeout waiting for message');

    harness.daemon.emit('discovery:session-waiting', {
      sessionId: 'disc-1',
      directoryId: 'dir-1',
      waiting: true,
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    });

    const waitingA = await watcher.waitForType('discovered-session-waiting');
    const waitingB = await passive.waitForType('discovered-session-waiting');
    expect(waitingA['waiting']).toBe(true);
    expect(waitingB['waiting']).toBe(true);

    watcher.close();
    passive.close();
  });

  it('supports supervised hook permission round-trip over websocket', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
      hooks: true,
    });

    const supervisor = await harness.connectClient();
    await supervisor.waitForType('hello');

    supervisor.send({
      type: 'supervise',
      sessionId: 'sess-hook-1',
      active: true,
      requestId: 'sup-1',
    });
    const superviseAck = await supervisor.waitForAck('sup-1');
    expect(superviseAck['status']).toBe('ok');

    const hookResponsePromise = harness.hookRouter.handleEvent(
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-hook-1',
        cwd: '/tmp/project',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      },
      'claude',
    );

    const hookRequest = await supervisor.waitForType('hook-permission-request');
    const hookRequestId = String(hookRequest['hookRequestId']);
    expect(hookRequestId.length).toBeGreaterThan(0);

    supervisor.send({
      type: 'respond-hook-permission',
      hookRequestId,
      decision: { behavior: 'allow' },
      requestId: 'resp-1',
    });

    const responseAck = await supervisor.waitForAck('resp-1');
    expect(responseAck['status']).toBe('ok');

    const hookResponse = await hookResponsePromise;
    expect(hookResponse.passthrough).toBe(false);
    expect(hookResponse.decision?.behavior).toBe('allow');

    supervisor.close();
  });
});
