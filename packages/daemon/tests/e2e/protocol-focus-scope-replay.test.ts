import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolHarness } from './support/protocol-harness.js';
import { FakeAdapter } from './support/fake-agent.js';

describe('protocol e2e: focus-scoped active replay', () => {
  let harness: ProtocolHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it('replays missed updates when switching back to a previously viewed active session', async () => {
    harness = await ProtocolHarness.start({
      adapters: [new FakeAdapter('claude')],
    });

    const client = await harness.connectClient();
    await client.waitForType('hello');

    client.send({
      type: 'subscribe',
      sessionId: 'sess-a',
      requestId: 'sub-a-1',
    });
    const subA1Ack = await client.waitForAck('sub-a-1');
    expect(subA1Ack['status']).toBe('ok');

    harness.daemon.emit('session:message', {
      sessionId: 'sess-a',
      message: {
        type: 'agent_message',
        text: 'A1',
        messageId: 'a1',
        timestamp: Date.now(),
      },
    });
    const a1 = await client.waitForType('session-update');
    expect(a1['sessionId']).toBe('sess-a');

    client.send({
      type: 'unsubscribe',
      sessionId: 'sess-a',
      requestId: 'unsub-a',
    });
    const unsubAAck = await client.waitForAck('unsub-a');
    expect(unsubAAck['status']).toBe('ok');

    client.send({
      type: 'subscribe',
      sessionId: 'sess-b',
      requestId: 'sub-b-1',
    });
    const subB1Ack = await client.waitForAck('sub-b-1');
    expect(subB1Ack['status']).toBe('ok');

    harness.daemon.emit('session:message', {
      sessionId: 'sess-a',
      message: {
        type: 'agent_message',
        text: 'A2',
        messageId: 'a2',
        timestamp: Date.now(),
      },
    });
    harness.daemon.emit('session:message', {
      sessionId: 'sess-b',
      message: {
        type: 'agent_message',
        text: 'B1',
        messageId: 'b1',
        timestamp: Date.now(),
      },
    });

    const b1 = await client.waitForType('session-update');
    expect(b1['sessionId']).toBe('sess-b');
    expect((b1['update'] as Record<string, unknown>)['updateType']).toBe('agent-message');

    client.send({
      type: 'unsubscribe',
      sessionId: 'sess-b',
      requestId: 'unsub-b',
    });
    const unsubBAck = await client.waitForAck('unsub-b');
    expect(unsubBAck['status']).toBe('ok');

    client.send({
      type: 'subscribe',
      sessionId: 'sess-a',
      lastSeq: 1,
      requestId: 'sub-a-2',
    });

    const replay = await client.waitForType('session-update');
    expect(replay['sessionId']).toBe('sess-a');
    expect((replay['update'] as Record<string, unknown>)['updateType']).toBe('agent-message');
    expect((replay['update'] as Record<string, unknown>)['text']).toBe('A2');

    const subA2Ack = await client.waitForAck('sub-a-2');
    expect(subA2Ack['status']).toBe('ok');
    expect(subA2Ack['replayCount']).toBe(1);

    client.close();
  });
});
