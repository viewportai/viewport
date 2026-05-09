import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProtocolHarness, type WsMessage } from './support/protocol-harness.js';
import { FakeAdapter, StaticDiscovery } from './support/fake-agent.js';
import { addContextEntry, initContextResource } from '../../src/context/local-edge-store.js';

function isSessionUpdate(msg: WsMessage): boolean {
  return msg['type'] === 'session-update';
}

function updateType(msg: WsMessage): string | undefined {
  const update = msg['update'];
  if (typeof update !== 'object' || update === null) return undefined;
  const value = (update as Record<string, unknown>)['updateType'];
  return typeof value === 'string' ? value : undefined;
}

function updateText(msg: WsMessage): string | undefined {
  const update = msg['update'];
  if (typeof update !== 'object' || update === null) return undefined;
  const value = (update as Record<string, unknown>)['text'];
  return typeof value === 'string' ? value : undefined;
}

describe('protocol e2e: session lifecycle', () => {
  let harness: ProtocolHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it('launch sends started/ack, then delivers prompt messages without phantom continue', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
    });
    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);

    const client = await harness.connectClient();
    await client.waitForType('hello');

    const prompt = 'can you tell me if you are running';
    client.send({
      type: 'launch',
      directoryId: directory.id,
      resourceId: 'resource-explicit',
      prompt,
      requestId: 'launch-1',
    });

    const started = await client.waitForType('session-started');
    const sessionId = String(started['sessionId']);
    expect(sessionId.length).toBeGreaterThan(0);
    expect(started['resourceId']).toBe('resource-explicit');
    expect(started).not.toHaveProperty('projectId');

    const ack = await client.waitForAck('launch-1');
    expect(ack['status']).toBe('ok');

    const userUpdate = await client.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === sessionId &&
        updateType(msg) === 'user-message' &&
        updateText(msg) === prompt,
      5_000,
    );
    expect(userUpdate).toBeDefined();

    const agentUpdate = await client.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === sessionId &&
        updateType(msg) === 'agent-message',
      5_000,
    );
    expect(agentUpdate).toBeDefined();

    const allPromptTexts = [userUpdate, agentUpdate]
      .map((m) => updateText(m))
      .filter((value): value is string => !!value);
    expect(allPromptTexts).not.toContain('Continue.');

    client.close();
  });

  it('launch injects Context Vault entries requested by repo config into the initial prompt', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
    });
    const projectPath = await harness.createProject();
    await fs.mkdir(path.join(projectPath, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, '.viewport', 'config.json'),
      JSON.stringify(
        {
          version: 1,
          resources: {
            contexts: ['ctx-session-launch'],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const credentials = { passphrase: 'alice-passphrase', recoveryCode: 'alice-recovery' };
    await initContextResource({
      contextResourceId: 'ctx-session-launch',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
    });
    await addContextEntry({
      contextResourceId: 'ctx-session-launch',
      actorName: 'alice-laptop',
      title: 'Launch context',
      body: 'Use the resource manifest when starting agents from this repo.',
      credentials,
    });

    const directory = await harness.registerDirectory(projectPath);
    const client = await harness.connectClient();
    await client.waitForType('hello');

    client.send({
      type: 'launch',
      directoryId: directory.id,
      prompt: 'Start the implementation.',
      requestId: 'launch-with-context',
    });

    const started = await client.waitForType('session-started');
    const sessionId = String(started['sessionId']);
    await client.waitForAck('launch-with-context');

    const userUpdate = await client.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === sessionId &&
        updateType(msg) === 'user-message',
      5_000,
    );
    const sentPrompt = updateText(userUpdate) ?? '';
    expect(sentPrompt).toContain('<viewport_context>');
    expect(sentPrompt).toContain('## ctx-session-launch');
    expect(sentPrompt).toContain('### Launch context');
    expect(sentPrompt).toContain('Use the resource manifest when starting agents from this repo.');
    expect(sentPrompt).toContain('<user_request>');
    expect(sentPrompt).toContain('Start the implementation.');

    client.close();
  }, 15_000);

  it('resume replays buffered updates before ack and sends prompt updates after attach', async () => {
    const claudeAdapter = new FakeAdapter('claude');
    const geminiAdapter = new FakeAdapter('gemini');
    const geminiDiscovery = new StaticDiscovery('gemini');

    harness = await ProtocolHarness.start({
      adapters: [claudeAdapter, geminiAdapter],
      discoveries: [geminiDiscovery],
    });

    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);

    geminiDiscovery.setProjectSessions(projectPath, [
      {
        agentId: 'gemini',
        sessionId: 'resume-target-1',
        summary: 'Recover previous run',
        lastModified: Date.now(),
        resumable: true,
      },
    ]);
    const client = await harness.connectClient();
    await client.waitForType('hello');

    await harness.runDiscoveryBroadcast();
    await client.waitForType('discovered-sessions-updated');

    harness.daemon.emit('session:message', {
      sessionId: 'resume-target-1',
      message: {
        type: 'agent_message',
        text: 'historical message',
        messageId: 'hist-1',
        timestamp: Date.now(),
      },
    });

    const prompt = 'resume and continue from the last checkpoint';
    client.send({
      type: 'resume',
      directoryId: directory.id,
      sessionId: 'resume-target-1',
      prompt,
      requestId: 'resume-1',
    });

    const started = await client.waitForType('session-started');
    expect(started['sessionId']).toBe('resume-target-1');
    expect(started['agent']).toBe('gemini');

    const replay = await client.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === 'resume-target-1' &&
        updateType(msg) === 'agent-message' &&
        updateText(msg) === 'historical message',
      5_000,
    );
    expect(replay).toBeDefined();

    const ack = await client.waitForAck('resume-1');
    expect(ack['status']).toBe('ok');

    const resumedUserUpdate = await client.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === 'resume-target-1' &&
        updateType(msg) === 'user-message' &&
        updateText(msg) === prompt,
      5_000,
    );
    expect(resumedUserUpdate).toBeDefined();

    client.close();
  });

  it('replays only missed updates when resubscribing with lastSeq', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
    });
    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);

    const clientA = await harness.connectClient();
    await clientA.waitForType('hello');

    clientA.send({
      type: 'launch',
      directoryId: directory.id,
      prompt: 'first prompt',
      requestId: 'launch-replay',
    });
    const started = await clientA.waitForType('session-started');
    const sessionId = String(started['sessionId']);
    await clientA.waitForAck('launch-replay');

    await clientA.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === sessionId &&
        updateType(msg) === 'user-message' &&
        updateText(msg) === 'first prompt',
      5_000,
    );
    await clientA.waitFor(
      (msg) =>
        isSessionUpdate(msg) &&
        msg['sessionId'] === sessionId &&
        updateType(msg) === 'agent-message' &&
        updateText(msg)?.includes('first prompt') === true,
      5_000,
    );

    clientA.send({
      type: 'prompt',
      sessionId,
      text: 'second prompt',
      requestId: 'prompt-replay',
    });
    await clientA.waitForAck('prompt-replay');

    const updates = await clientA.collectMessages(2, 5_000);
    const updateSeqs = updates
      .map((msg) => Number(msg['seq']))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const lastSeq = updateSeqs[updateSeqs.length - 1] ?? 0;
    expect(lastSeq).toBeGreaterThan(0);
    clientA.close();

    const clientB = await harness.connectClient();
    await clientB.waitForType('hello');
    clientB.send({
      type: 'subscribe',
      sessionId,
      lastSeq: lastSeq - 1,
      requestId: 'sub-replay',
    });

    const replayed = await clientB.waitFor(
      (msg) => isSessionUpdate(msg) && msg['sessionId'] === sessionId,
      5_000,
    );
    expect(Number(replayed['seq'])).toBe(lastSeq);

    const ack = await clientB.waitForAck('sub-replay');
    expect(ack['status']).toBe('ok');
    expect(ack['replayCount']).toBe(1);

    clientB.close();
  });

  it('hello after reconnect includes launched active session', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
    });
    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);

    const clientA = await harness.connectClient();
    await clientA.waitForType('hello');
    clientA.send({
      type: 'launch',
      directoryId: directory.id,
      prompt: 'persist across refresh',
      requestId: 'launch-refresh',
    });
    const started = await clientA.waitForType('session-started');
    const sessionId = String(started['sessionId']);
    await clientA.waitForAck('launch-refresh');
    clientA.close();

    const clientB = await harness.connectClient();
    const hello = await clientB.waitForType('hello');
    const active = (hello['activeSessions'] as Array<Record<string, unknown>>) ?? [];
    const found = active.find((s) => s['id'] === sessionId);
    expect(found).toBeDefined();
    expect(found?.['directoryId']).toBe(directory.id);

    clientB.close();
  });

  it('sync-request returns fresh discovered and active session state for late joiners', async () => {
    const claudeAdapter = new FakeAdapter('claude');
    const geminiDiscovery = new StaticDiscovery('gemini');

    harness = await ProtocolHarness.start({
      adapters: [claudeAdapter],
      discoveries: [geminiDiscovery],
    });

    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);

    geminiDiscovery.setProjectSessions(projectPath, [
      {
        agentId: 'gemini',
        sessionId: 'late-join-discovered',
        summary: 'Recovered from history',
        lastModified: Date.now(),
        resumable: true,
      },
    ]);
    await harness.runDiscoveryBroadcast();

    const bootstrapClient = await harness.connectClient();
    await bootstrapClient.waitForType('hello');
    bootstrapClient.send({
      type: 'launch',
      directoryId: directory.id,
      prompt: 'sync me',
      requestId: 'launch-sync-late-join',
    });
    const started = await bootstrapClient.waitForType('session-started');
    const activeSessionId = String(started['sessionId']);
    await bootstrapClient.waitForAck('launch-sync-late-join');
    bootstrapClient.close();

    const lateJoiner = await harness.connectClient();
    await lateJoiner.waitForType('hello');
    lateJoiner.send({
      type: 'sync-request',
      requestId: 'sync-late-join',
    });

    const snapshot = await lateJoiner.waitForType('sync-snapshot');
    const ack = await lateJoiner.waitForAck('sync-late-join');

    expect(ack['status']).toBe('ok');
    expect(snapshot['directories']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: directory.id })]),
    );
    expect(snapshot['activeSessions']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: activeSessionId, directoryId: directory.id }),
      ]),
    );
    expect(snapshot['discoveredSessions']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'late-join-discovered', directoryId: directory.id }),
      ]),
    );

    lateJoiner.close();
  });
});
