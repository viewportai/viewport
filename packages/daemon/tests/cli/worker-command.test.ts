import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('worker command', () => {
  const originalArgv = process.argv.slice();
  const originalHome = process.env['VIEWPORT_HOME'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-worker-command-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalHome) process.env['VIEWPORT_HOME'] = originalHome;
    else delete process.env['VIEWPORT_HOME'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('reports missing worker prerequisites without falling back to monitor state', async () => {
    process.argv = ['node', 'vpd', 'worker', 'doctor', '--json'];
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      missing: string[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.missing).toEqual(['server URL', 'workspace root', 'worker identity']);
  });

  it('keeps manual capability flags out of the default worker help path', async () => {
    process.argv = ['node', 'vpd', 'worker', 'help'];
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(output).toContain('vpd pair --worker --transport=polling --workdir <path>');
    expect(output).toContain('stop [--json]');
    expect(output).not.toContain('--agents');
    expect(output).not.toContain('--models');
    expect(output).not.toContain('--capabilities');
  });

  it('reports configured worker lifecycle, transport, and identity', async () => {
    process.argv = ['node', 'vpd', 'pair', '--worker'];
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');
    await storeWorkerProfile(
      null,
      await resolveWorkerProfileDefaults({
        server: await resolvePairingServerTransport(),
        detectCapabilities: false,
      }),
    );

    process.argv = ['node', 'vpd', 'worker', 'doctor', '--json'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      lifecycle: string;
      transport: string;
      serverUrl: string;
      workspaceRoot: string;
      publicKeyFingerprint: string;
      capabilities: { agents: Record<string, unknown> };
      missing: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.lifecycle).toBe('persistent');
    expect(payload.transport).toBe('polling');
    expect(payload.serverUrl).toBe('https://api.getviewport.com');
    expect(payload.workspaceRoot).toBe(path.join(homeDir, 'workspace'));
    expect(payload.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.capabilities.agents).toEqual({});
    expect(payload.missing).toEqual([]);
  });

  it('removes stale persistent worker locks for the paired profile', async () => {
    process.argv = ['node', 'vpd', 'pair', '--worker'];
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');
    const { acquireWorkerProcessLock } =
      await import('../../src/cli/worker-process-lock.js');
    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });
    await storeWorkerProfile(null, profile);
    const lock = acquireWorkerProcessLock({
      server: profile.serverUrl,
      workspaceId: profile.publicKeyFingerprint,
      executorId: profile.publicKeyFingerprint,
      accessMode: profile.transport,
    });
    const record = JSON.parse(await fs.readFile(lock.filePath, 'utf8')) as Record<string, unknown>;
    record['pid'] = 999_999_999;
    await fs.writeFile(lock.filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    process.argv = ['node', 'vpd', 'worker', 'stop', '--json'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      stopped: boolean;
      stale: boolean;
      pid: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.stopped).toBe(false);
    expect(payload.stale).toBe(true);
    expect(payload.pid).toBe(999_999_999);
    await expect(fs.stat(lock.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
