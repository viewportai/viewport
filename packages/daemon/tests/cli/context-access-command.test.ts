import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('context access lifecycle CLI commands', () => {
  const originalArgv = process.argv.slice();
  const originalFetch = globalThis.fetch;
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-access-cli-'));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('approves a second device and resolves synced resource history through vpd only', async () => {
    const laptopHome = path.join(tempHome, 'alice-laptop-home');
    const desktopHome = path.join(tempHome, 'alice-desktop-home');
    const repo = path.join(tempHome, 'alice-contract-repo');
    const requestFile = path.join(tempHome, 'device-request.json');
    const approvalFile = path.join(tempHome, 'device-approval.json');
    const laptopIdentityFile = path.join(tempHome, 'alice-laptop-identity.json');
    const pushedEvents = await setupSyncedAliceContext(laptopHome);

    await runContext([
      'context',
      'device-request',
      '--home',
      desktopHome,
      '--device',
      'alice-desktop',
      '--code',
      '123456',
      '--out',
      requestFile,
      '--key-store',
      'file',
      '--json',
    ]);
    await runContext([
      'context',
      'device-approve',
      '--home',
      laptopHome,
      '--user',
      'alice',
      '--request-file',
      requestFile,
      '--code',
      '123456',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--out',
      approvalFile,
      '--json',
    ]);
    await runContext([
      'context',
      'device-accept',
      '--home',
      desktopHome,
      '--user',
      'alice',
      '--device',
      'alice-desktop',
      '--approval-file',
      approvalFile,
      '--code',
      '123456',
      '--key-store',
      'file',
      '--json',
    ]);
    await runContext([
      'context',
      'join',
      '--home',
      desktopHome,
      '--context',
      'context-alpha',
      '--user',
      'alice',
      '--device',
      'alice-desktop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--key-store',
      'file',
      '--json',
    ]);
    await runContext([
      'context',
      'identity-export',
      '--home',
      laptopHome,
      '--name',
      'alice-laptop',
      '--out',
      laptopIdentityFile,
      '--json',
    ]);
    await runContext([
      'context',
      'identity-import',
      '--home',
      desktopHome,
      '--identity-file',
      laptopIdentityFile,
      '--json',
    ]);

    mockPullOnly(pushedEvents);
    await writeRelayConfig(desktopHome, 'context-alpha');
    await runContext([
      'context',
      'sync-pull',
      '--home',
      desktopHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-desktop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    logSpy.mockClear();
    await runContext([
      'context',
      'resolve',
      '--home',
      desktopHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-desktop',
      '--query',
      'handoff',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'Shared handoff policy is available to approved devices.',
    );

    logSpy.mockClear();
    await runContext([
      'context',
      'use',
      'context-alpha',
      '--path',
      repo,
      '--provider',
      'handoff',
      '--json',
    ]);
    await runContext([
      'context',
      'search',
      '--home',
      desktopHome,
      '--path',
      repo,
      '--provider',
      'handoff',
      '--device',
      'alice-desktop',
      '--query',
      'handoff',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    const contractOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(contractOutput).toContain('"command": "context use"');
    expect(contractOutput).toContain('"provider_id": "handoff"');
    expect(contractOutput).toContain('Shared handoff policy is available to approved devices.');
  });

  it('grants a second user and lets that user resolve synced resource context through vpd only', async () => {
    const aliceHome = path.join(tempHome, 'alice-home');
    const bobHome = path.join(tempHome, 'bob-home');
    const aliceIdentityFile = path.join(tempHome, 'alice-identity.json');
    const aliceLaptopIdentityFile = path.join(tempHome, 'alice-laptop-identity.json');
    const bobIdentityFile = path.join(tempHome, 'bob-identity.json');
    await setupSyncedAliceContext(aliceHome);

    await runContext([
      'context',
      'user-init',
      '--home',
      bobHome,
      '--user',
      'bob',
      '--device',
      'bob-laptop',
      '--passphrase',
      'bob-passphrase',
      '--recovery-code',
      'bob-recovery',
      '--key-store',
      'file',
      '--json',
    ]);
    await runContext([
      'context',
      'identity-export',
      '--home',
      bobHome,
      '--name',
      'bob',
      '--out',
      bobIdentityFile,
      '--json',
    ]);
    await runContext([
      'context',
      'identity-import',
      '--home',
      aliceHome,
      '--identity-file',
      bobIdentityFile,
      '--json',
    ]);
    await runContext([
      'context',
      'grant',
      '--home',
      aliceHome,
      '--context',
      'context-alpha',
      '--actor',
      'alice-laptop',
      '--recipient',
      'bob',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    await runContext([
      'context',
      'join',
      '--home',
      bobHome,
      '--context',
      'context-alpha',
      '--user',
      'bob',
      '--device',
      'bob-laptop',
      '--passphrase',
      'bob-passphrase',
      '--recovery-code',
      'bob-recovery',
      '--key-store',
      'file',
      '--json',
    ]);
    await runContext([
      'context',
      'identity-export',
      '--home',
      aliceHome,
      '--name',
      'alice',
      '--out',
      aliceIdentityFile,
      '--json',
    ]);
    await runContext([
      'context',
      'identity-import',
      '--home',
      bobHome,
      '--identity-file',
      aliceIdentityFile,
      '--json',
    ]);
    await runContext([
      'context',
      'identity-export',
      '--home',
      aliceHome,
      '--name',
      'alice-laptop',
      '--out',
      aliceLaptopIdentityFile,
      '--json',
    ]);
    await runContext([
      'context',
      'identity-import',
      '--home',
      bobHome,
      '--identity-file',
      aliceLaptopIdentityFile,
      '--json',
    ]);

    const pushedEvents: unknown[] = [];
    mockPushThenPull(pushedEvents);
    await writeRelayConfig(aliceHome, 'context-alpha');
    await runContext([
      'context',
      'sync-push',
      '--home',
      aliceHome,
      '--context',
      'context-alpha',
      '--json',
    ]);
    await writeRelayConfig(bobHome, 'context-alpha');
    await runContext([
      'context',
      'sync-pull',
      '--home',
      bobHome,
      '--context',
      'context-alpha',
      '--device',
      'bob-laptop',
      '--passphrase',
      'bob-passphrase',
      '--recovery-code',
      'bob-recovery',
      '--json',
    ]);

    logSpy.mockClear();
    await runContext([
      'context',
      'resolve',
      '--home',
      bobHome,
      '--context',
      'context-alpha',
      '--device',
      'bob-laptop',
      '--query',
      'handoff',
      '--passphrase',
      'bob-passphrase',
      '--recovery-code',
      'bob-recovery',
      '--json',
    ]);
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'Shared handoff policy is available to approved devices.',
    );
  });

  async function runContext(args: string[]): Promise<void> {
    process.argv = ['node', 'vpd', ...args];
    vi.resetModules();
    const { context } = await import('../../src/cli/context-command.js');
    await context();
  }

  async function setupSyncedAliceContext(home: string): Promise<unknown[]> {
    await runContext([
      'context',
      'init',
      '--home',
      home,
      '--context',
      'context-alpha',
      '--user',
      'alice',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--key-store',
      'file',
      '--json',
    ]);
    await runContext([
      'context',
      'add',
      '--home',
      home,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--title',
      'Shared handoff',
      '--body',
      'Shared handoff policy is available to approved devices.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const pushedEvents: unknown[] = [];
    mockPushThenPull(pushedEvents);
    await writeRelayConfig(home, 'context-alpha');
    await runContext([
      'context',
      'sync-push',
      '--home',
      home,
      '--context',
      'context-alpha',
      '--json',
    ]);
    return pushedEvents;
  }

  async function writeRelayConfig(home: string, workspaceId: string): Promise<void> {
    const previous = process.env['VIEWPORT_HOME'];
    process.env['VIEWPORT_HOME'] = home;
    vi.resetModules();
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      server: { url: 'https://app.getviewport.test' },
      relay: {
        enabled: true,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'https://app.getviewport.test',
        workspaceId,
        issueToken: 'runtime-token',
        tlsVerify: '1',
      },
    });
    if (previous === undefined) {
      delete process.env['VIEWPORT_HOME'];
    } else {
      process.env['VIEWPORT_HOME'] = previous;
    }
  }

  function mockPullOnly(pushedEvents: unknown[]): void {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        'https://app.getviewport.test/api/runtime/workspaces/context-alpha/context-vault/events/pull',
      );
      return jsonResponse({
        data: pushedEvents.map((event, index) => ({ id: index + 1, signed_event: event })),
      });
    }) as typeof fetch;
  }

  function mockPushThenPull(pushedEvents: unknown[]): void {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/push')) {
        pushedEvents.splice(0, pushedEvents.length, ...(body.events as unknown[]));
        expect(JSON.stringify(pushedEvents)).toContain('viewport.context_event/v1');
        expect(JSON.stringify(pushedEvents)).not.toContain(
          'Shared handoff policy is available to approved devices.',
        );
        return jsonResponse({ ok: true, accepted: pushedEvents.length, events: [] }, 202);
      }
      if (String(url).endsWith('/grants/materialized')) {
        return jsonResponse({ ok: true, materialized: body.grant_event_ids?.length ?? 0 });
      }
      return jsonResponse({
        data: pushedEvents.map((event, index) => ({ id: index + 1, signed_event: event })),
      });
    }) as typeof fetch;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
});
