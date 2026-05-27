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
    const { resolvePairingServerTransport } = await import(
      '../../src/cli/lifecycle-pair-server.js'
    );
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
    const { resolvePairingServerTransport } = await import(
      '../../src/cli/lifecycle-pair-server.js'
    );
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

  it('persists worker profile config and identity without monitor state', async () => {
    const { resolvePairingServerTransport } = await import(
      '../../src/cli/lifecycle-pair-server.js'
    );
    const { resolveWorkerProfileDefaults, storeWorkerProfile } = await import(
      '../../src/cli/worker-profile.js'
    );

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
    await expect(fs.readFile(path.join(homeDir, 'worker', 'identity.json'), 'utf8')).resolves.toContain(
      'BEGIN PRIVATE KEY',
    );
  });
});
