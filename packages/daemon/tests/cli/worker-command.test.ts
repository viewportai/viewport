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

  it('reports managed-executor worker flags as a configured worker profile', async () => {
    const tokenPath = path.join(homeDir, 'managed-token');
    await fs.writeFile(tokenPath, 'worker-secret\n', 'utf8');
    process.argv = [
      'node',
      'vpd',
      'worker',
      'doctor',
      '--json',
      '--server',
      'https://api.getviewport.test',
      '--workspace',
      'workspace_1',
      '--executor',
      'executor_1',
      '--credential-file',
      tokenPath,
      '--workdir',
      path.join(homeDir, 'worktrees'),
      '--runner-pool',
      'organization-default',
    ];
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      runtimeProfile: string;
      transport: string;
      serverUrl: string;
      workspaceId: string;
      executorId: string;
      workspaceRoot: string;
      runnerPool: string;
      credentialSource: string;
      processLock: {
        active: boolean;
        stale: boolean;
        pid: number | null;
        startedAt: string | null;
      };
      supportPacket: {
        docsUrl: string;
        reviewBeforeSharing: boolean;
        omittedSecrets: string[];
      };
      missing: string[];
      warnings: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.runtimeProfile).toBe('managed-executor');
    expect(payload.transport).toBe('polling');
    expect(payload.serverUrl).toBe('https://api.getviewport.test');
    expect(payload.workspaceId).toBe('workspace_1');
    expect(payload.executorId).toBe('executor_1');
    expect(payload.workspaceRoot).toBe(path.join(homeDir, 'worktrees'));
    expect(payload.runnerPool).toBe('organization-default');
    expect(payload.credentialSource).toBe('file');
    expect(payload.processLock).toEqual({
      active: false,
      stale: false,
      pid: null,
      startedAt: null,
    });
    expect(payload.supportPacket.docsUrl).toBe('https://docs.getviewport.com/troubleshooting/support-packet');
    expect(payload.supportPacket.reviewBeforeSharing).toBe(true);
    expect(payload.supportPacket.omittedSecrets).toContain('lease_tokens');
    expect(payload.supportPacket.omittedSecrets).toContain('worker_private_keys');
    expect(payload.missing).toEqual([]);
    expect(payload.warnings).toEqual([]);
  });

  it('reports managed-executor registration profiles without printing credentials', async () => {
    const profilePath = path.join(homeDir, 'registration-profile.json');
    await fs.writeFile(
      profilePath,
      JSON.stringify(
        {
          schema: 'viewport.managed_executor_registration/v1',
          server_url: 'https://api.getviewport.test',
          workspace_id: 'workspace_profile',
          managed_executor_id: 'executor_profile',
          credential: 'secret-value',
          access_mode: 'polling',
          runner_profile: 'organization-default',
          capabilities: { integrations: ['github', 'slack'] },
        },
        null,
        2,
      ),
      'utf8',
    );
    process.argv = [
      'node',
      'vpd',
      'worker',
      'doctor',
      '--json',
      '--registration-profile',
      profilePath,
    ];
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const raw = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(raw) as {
      ok: boolean;
      runtimeProfile: string;
      credentialSource: string;
      supportPacket: { docsUrl: string; omittedSecrets: string[] };
      missing: string[];
      warnings: string[];
      capabilities: { integrations: string[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.runtimeProfile).toBe('managed-executor');
    expect(payload.credentialSource).toBe('profile');
    expect(payload.supportPacket.docsUrl).toBe('https://docs.getviewport.com/troubleshooting/support-packet');
    expect(payload.supportPacket.omittedSecrets).toContain('credentials');
    expect(payload.missing).toEqual([]);
    expect(payload.warnings).toContain('workspace root not pinned; pass --workdir for predictable checkouts');
    expect(payload.capabilities.integrations).toEqual(['github', 'slack']);
    expect(raw).not.toContain('secret-value');
  });

  it('keeps manual capability flags out of the default worker help path', async () => {
    process.argv = ['node', 'vpd', 'worker', 'help'];
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(output).toContain('vpd pair --worker --transport=polling --workdir <path>');
    expect(output).toContain('doctor [--json] [--registration-profile <path>]');
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
      workspaceId: string | null;
      workspaceRoot: string;
      publicKeyFingerprint: string;
      capabilities: { agents: Record<string, unknown> };
      processLock: {
        active: boolean;
        stale: boolean;
        pid: number | null;
        startedAt: string | null;
      };
      supportPacket: { docsUrl: string; omittedSecrets: string[] };
      missing: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.lifecycle).toBe('persistent');
    expect(payload.transport).toBe('polling');
    expect(payload.serverUrl).toBe('https://api.getviewport.com');
    expect(payload.workspaceId).toBe(null);
    expect(payload.workspaceRoot).toBe(path.join(homeDir, 'workspace'));
    expect(payload.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.capabilities.agents).toEqual({});
    expect(payload.processLock).toEqual({
      active: false,
      stale: false,
      pid: null,
      startedAt: null,
    });
    expect(payload.supportPacket.docsUrl).toBe('https://docs.getviewport.com/troubleshooting/support-packet');
    expect(payload.supportPacket.omittedSecrets).toContain('claim_tokens');
    expect(payload.missing).toEqual([]);
  });

  it('reports the approved workspace id without printing the worker credential', async () => {
    process.argv = ['node', 'vpd', 'pair', '--worker'];
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');
    await storeWorkerProfile(
      {
        status: 'approved',
        workspace_id: 'workspace_launch',
        workspace_name: 'Launch Workspace',
        managed_executor_id: 'executor_launch',
        managed_executor_credential: 'secret-managed-worker-token',
        token: 'secret-relay-token',
        server_id: 'server_launch',
      },
      await resolveWorkerProfileDefaults({
        server: await resolvePairingServerTransport(),
        detectCapabilities: false,
      }),
    );

    process.argv = ['node', 'vpd', 'worker', 'doctor', '--json'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const raw = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(raw) as {
      ok: boolean;
      serverUrl: string;
      workspaceId: string;
      missing: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.serverUrl).toBe('https://api.getviewport.com');
    expect(payload.workspaceId).toBe('workspace_launch');
    expect(payload.missing).toEqual([]);
    expect(raw).not.toContain('secret-managed-worker-token');
    expect(raw).not.toContain('secret-relay-token');
  });

  it('prints the approved workspace id in human worker doctor output', async () => {
    process.argv = ['node', 'vpd', 'pair', '--worker'];
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');
    await storeWorkerProfile(
      {
        status: 'approved',
        workspace_id: 'workspace_human',
        workspace_name: 'Human Workspace',
        managed_executor_id: 'executor_human',
        managed_executor_credential: 'secret-human-worker-token',
        token: 'secret-human-relay-token',
        server_id: 'server_human',
      },
      await resolveWorkerProfileDefaults({
        server: await resolvePairingServerTransport(),
        detectCapabilities: false,
      }),
    );

    process.argv = ['node', 'vpd', 'worker', 'doctor'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const output = logSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(output).toContain('Workspace: workspace_human');
    expect(output).toContain('Status:    configured');
    expect(output).not.toContain('secret-human-worker-token');
    expect(output).not.toContain('secret-human-relay-token');
  });

  it('blocks worker start when local config drifts from the approved pairing record', async () => {
    process.argv = ['node', 'vpd', 'pair', '--worker'];
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');
    await storeWorkerProfile(
      {
        status: 'approved',
        workspace_id: 'workspace_pinned',
        workspace_name: 'Pinned Workspace',
        managed_executor_id: 'executor_pinned',
        managed_executor_credential: 'secret-pinned-worker-token',
        token: 'secret-pinned-relay-token',
        server_id: 'server_pinned',
      },
      await resolveWorkerProfileDefaults({
        server: await resolvePairingServerTransport(),
        detectCapabilities: false,
      }),
    );
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const daemonConfig = manager.getDaemonConfig();
    await manager.setDaemonConfig({
      ...daemonConfig,
      worker: {
        ...daemonConfig?.worker,
        workspaceId: 'workspace_wrong',
      },
    });

    process.argv = ['node', 'vpd', 'worker', 'doctor', '--json'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const raw = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(raw) as {
      ok: boolean;
      pairingIntegrity: {
        ok: boolean;
        pairingPresent: boolean;
        mismatches: string[];
      };
    };
    expect(payload.ok).toBe(false);
    expect(payload.pairingIntegrity).toEqual({
      ok: false,
      pairingPresent: true,
      mismatches: ['workspaceId'],
    });
    expect(raw).not.toContain('secret-pinned-worker-token');
    expect(raw).not.toContain('secret-pinned-relay-token');

    process.argv = ['node', 'vpd', 'worker', 'start', '--once'];
    vi.resetModules();
    const { worker: startWorker } = await import('../../src/cli/worker-command.js');
    await expect(startWorker()).rejects.toThrow(
      'Worker profile does not match the approved pairing record: workspaceId.',
    );
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

  it('reports stale persistent worker locks in doctor output', async () => {
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
    record['pid'] = 999_999_998;
    await fs.writeFile(lock.filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    process.argv = ['node', 'vpd', 'worker', 'doctor', '--json'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      processLock: {
        active: boolean;
        stale: boolean;
        pid: number | null;
        startedAt: string | null;
      };
    };
    expect(payload.processLock).toMatchObject({
      active: false,
      stale: true,
      pid: 999_999_998,
    });
    expect(payload.processLock.startedAt).toEqual(expect.any(String));
  });
});
