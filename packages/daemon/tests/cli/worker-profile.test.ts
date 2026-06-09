import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('worker profile defaults', () => {
  const originalArgv = process.argv.slice();
  const originalHome = process.env['VIEWPORT_HOME'];
  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-worker-profile-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
    process.argv = ['node', 'vpd', 'pair', '--worker'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalHome) process.env['VIEWPORT_HOME'] = originalHome;
    else delete process.env['VIEWPORT_HOME'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('uses hosted Viewport and polling worker defaults with an isolated workspace root', async () => {
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults } = await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });

    expect(profile.lifecycle).toBe('persistent');
    expect(profile.transport).toBe('polling');
    expect(profile.serverUrl).toBe('https://api.getviewport.com');
    expect(profile.appUrl).toBe('https://app.getviewport.com');
    expect(profile.workspaceRoot).toBe(path.join(homeDir, 'workspace'));
    expect(profile.identityKeyPath).toBe(path.join(homeDir, 'worker', 'identity.json'));
    expect(profile.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(profile.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors self-hosted server and explicit transport flags', async () => {
    process.argv = [
      'node',
      'vpd',
      'pair',
      '--worker',
      '--server',
      'http://localhost:8780',
      '--transport',
      'relay',
      '--mode',
      'ephemeral',
    ];
    vi.resetModules();
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults } = await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });

    expect(profile.lifecycle).toBe('ephemeral');
    expect(profile.transport).toBe('relay');
    expect(profile.serverUrl).toBe('http://localhost:8780');
    expect(profile.appUrl).toBe('http://localhost:8780');
  });

  it('resolves customer-internal servers without hosted URL rewriting', async () => {
    process.argv = [
      'node',
      'vpd',
      'pair',
      '--worker',
      '--server',
      'https://viewport.customer.internal',
      '--transport',
      'polling',
    ];
    vi.resetModules();
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults } = await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });

    expect(profile.serverUrl).toBe('https://viewport.customer.internal');
    expect(profile.appUrl).toBe('https://viewport.customer.internal');
    expect(profile.transport).toBe('polling');
  });

  it('auto-detects built-in agent capabilities for worker pairing evidence', async () => {
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults } = await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
    });

    expect(Object.keys(profile.capabilities.agents).sort()).toEqual(['claude', 'codex', 'gemini']);
    for (const agent of Object.values(profile.capabilities.agents)) {
      expect(typeof agent.available).toBe('boolean');
    }
    expect(profile.capabilities.agents.claude?.models).toEqual(expect.arrayContaining(['sonnet']));
    expect(profile.capabilities.agents.codex?.models).toEqual(
      expect.arrayContaining(['gpt-5-codex']),
    );
    expect(profile.capabilities.integrations).toEqual(
      expect.arrayContaining(['github', 'slack', 'linear']),
    );
    expect(profile.capabilities.secrets).toEqual(
      expect.arrayContaining(['github/pr-writer', 'slack/notifier']),
    );
    expect(profile.capabilities.tools).toContain('shell');
    expect(profile.capabilities.tools).toContain('git');
  });

  it('carries an explicit runner pool through worker pairing defaults', async () => {
    process.argv = ['node', 'vpd', 'pair', '--worker', '--runner-pool', 'acme-local'];
    vi.resetModules();
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, workerPairingPayload } =
      await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });
    const payload = workerPairingPayload(profile);

    expect(profile.runnerPool).toBe('acme-local');
    expect(profile.capabilities.runner_pool).toBe('acme-local');
    expect(payload.worker_runner_pool).toBe('acme-local');
  });

  it('persists worker profile config and identity without monitor state', async () => {
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });
    await storeWorkerProfile(null, profile);

    const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8')) as {
      daemon: {
        server: { url: string };
        worker: {
          lifecycle: string;
          transport: string;
          serverUrl: string;
          workspaceRoot: string;
          publicKeyFingerprint: string;
        };
      };
    };
    expect(config.daemon.server.url).toBe('https://api.getviewport.com');
    expect(config.daemon.worker.lifecycle).toBe('persistent');
    expect(config.daemon.worker.transport).toBe('polling');
    expect(config.daemon.worker.workspaceRoot).toBe(path.join(homeDir, 'workspace'));
    expect(config.daemon.worker.publicKeyFingerprint).toBe(profile.publicKeyFingerprint);
    await expect(
      fs.readFile(path.join(homeDir, 'worker', 'identity.json'), 'utf8'),
    ).resolves.toContain('BEGIN PRIVATE KEY');
  });

  it('stores hosted managed executor fields returned by worker pairing approval', async () => {
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });
    await storeWorkerProfile(
      {
        status: 'approved',
        workspace_id: 'workspace_123',
        workspace_name: 'Payments',
        install_id: 'install_123',
        runtime_target_id: 'runtime_123',
        managed_executor_id: 'executor_123',
        managed_executor_credential: 'vpexec_secret',
        server_url: 'https://api.getviewport.test',
        server_id: 'sha256:server_123',
        token: 'install_daemon_issue_secret',
      },
      profile,
    );

    const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8')) as {
      daemon: {
        worker: {
          workspaceId: string;
          managedExecutorId: string;
          credential: string;
          serverId: string;
        };
      };
    };
    expect(config.daemon.worker.workspaceId).toBe('workspace_123');
    expect(config.daemon.worker.managedExecutorId).toBe('executor_123');
    expect(config.daemon.worker.credential).toBe('vpexec_secret');
    expect(config.daemon.worker.serverId).toBe('sha256:server_123');

    const pairing = JSON.parse(
      await fs.readFile(path.join(homeDir, 'worker', 'pairing.json'), 'utf8'),
    ) as {
      managedExecutorId: string;
      runtimeTargetId: string;
      serverUrl: string;
      serverId: string;
    };
    expect(pairing.runtimeTargetId).toBe('runtime_123');
    expect(pairing.managedExecutorId).toBe('executor_123');
    expect(pairing.serverUrl).toBe(profile.serverUrl);
    expect(pairing.serverId).toBe('sha256:server_123');
  });

  it('uses the active profile home for worker state instead of the monitor default home', async () => {
    process.env['VIEWPORT_PROFILE'] = 'payments-worker';
    vi.resetModules();
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');

    const profile = await resolveWorkerProfileDefaults({
      server: await resolvePairingServerTransport(),
      detectCapabilities: false,
    });
    await storeWorkerProfile(null, profile);

    const profileHome = path.join(homeDir, 'profiles', 'payments-worker');
    expect(profile.workspaceRoot).toBe(path.join(profileHome, 'workspace'));
    await expect(fs.readFile(path.join(profileHome, 'config.json'), 'utf8')).resolves.toContain(
      '"worker"',
    );
    await expect(fs.readFile(path.join(homeDir, 'config.json'), 'utf8')).rejects.toThrow();
  });
});
