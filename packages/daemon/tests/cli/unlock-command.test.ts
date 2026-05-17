import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('unlock CLI command', () => {
  const originalArgv = process.argv.slice();
  const originalFetch = globalThis.fetch;
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalCwd = process.cwd();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-unlock-cli-'));
    process.env['VIEWPORT_HOME'] = tempHome;
    process.chdir(tempHome);
    await writeRelayConfig();
  });

  afterEach(async () => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalViewportHome === undefined) {
      delete process.env['VIEWPORT_HOME'];
    } else {
      process.env['VIEWPORT_HOME'] = originalViewportHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('activates a trusted-edge unlock session without printing the runtime credential', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });

      return jsonResponse({
        ok: true,
        data: {
          id: 'unlock-session-1',
          status: 'active',
          expires_at: '2026-05-13T19:00:00.000Z',
        },
      });
    }) as unknown as typeof fetch;

    await runUnlock(['unlock', 'unlock-session-1', '--json']);

    expect(requests).toEqual([
      {
        url: 'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/trusted-edge-unlock-sessions/unlock-session-1/activate',
        body: { credential: 'runtime-token' },
      },
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "unlock"');
    expect(output).toContain('"workspaceId": "workspace-alpha"');
    expect(output).toContain('"id": "unlock-session-1"');
    expect(output).not.toContain('runtime-token');
  });

  it('surfaces platform unlock activation failures', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: 'Unlock session expired.' }, 410),
    ) as unknown as typeof fetch;

    await expect(runUnlock(['unlock', 'unlock-session-1', '--json'])).rejects.toThrow(
      'Unlock session expired.',
    );
  });

  async function runUnlock(args: string[]): Promise<void> {
    process.argv = ['node', 'vpd', ...args];
    vi.resetModules();
    const { unlock } = await import('../../src/cli/unlock-command.js');
    await unlock();
  }

  async function writeRelayConfig(): Promise<void> {
    vi.resetModules();
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      server: {
        url: 'https://app.getviewport.test',
        tlsVerify: '1',
      },
      relay: {
        enabled: true,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'https://app.getviewport.test',
        workspaceId: 'workspace-alpha',
        issueToken: 'runtime-token',
        tlsVerify: '1',
      },
    });
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
});
