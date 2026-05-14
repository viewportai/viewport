import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('profile CLI command', () => {
  const originalArgv = process.argv.slice();
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalViewportProfile = process.env['VIEWPORT_PROFILE'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-profile-cli-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    if (originalViewportProfile) process.env['VIEWPORT_PROFILE'] = originalViewportProfile;
    else delete process.env['VIEWPORT_PROFILE'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('creates a profile with server, app, relay, and listen config', async () => {
    process.argv = [
      'node',
      'vpd',
      'profile',
      'create',
      'prod',
      '--server',
      'https://api.getviewport.com',
      '--app-url',
      'https://app.getviewport.com',
      '--relay',
      'wss://relay.getviewport.com/ws',
      '--listen',
      '127.0.0.1:7071',
      '--json',
    ];

    const { profile } = await import('../../src/cli/profile-command.js');
    await profile();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      profile: { name: string; home: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.profile.name).toBe('prod');

    const config = JSON.parse(
      await fs.readFile(path.join(homeDir, 'profiles/prod/config.json'), 'utf8'),
    ) as {
      daemon: {
        listen: string;
        server: { url: string; appUrl: string };
        relay: { endpoint: string; serverUrl: string };
      };
    };
    expect(config.daemon.listen).toBe('127.0.0.1:7071');
    expect(config.daemon.server.url).toBe('https://api.getviewport.com');
    expect(config.daemon.server.appUrl).toBe('https://app.getviewport.com');
    expect(config.daemon.relay.endpoint).toBe('wss://relay.getviewport.com/ws');
    expect(config.daemon.relay.serverUrl).toBe('https://api.getviewport.com');
  });

  it('can seed a profile by copying the current daemon home first', async () => {
    await fs.writeFile(path.join(homeDir, 'auth-token'), 'local-token\n');
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-profile-repo-'));
    await fs.mkdir(path.join(repoDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, '.viewport/local.yaml'),
      'version: 1\norganization_id: 01LOCAL\nremote:\n  stream: enabled\n',
    );
    await fs.writeFile(
      path.join(homeDir, 'config.json'),
      JSON.stringify({
        directories: {
          repo: { path: repoDir },
        },
        daemon: { listen: '127.0.0.1:19990' },
      }),
    );
    process.argv = [
      'node',
      'vpd',
      'profile',
      'create',
      'local',
      '--copy-current',
      '--server',
      'https://api.getviewport.test',
      '--json',
    ];

    try {
      const { profile } = await import('../../src/cli/profile-command.js');
      await profile();

      await expect(
        fs.readFile(path.join(homeDir, 'profiles/local/auth-token'), 'utf8'),
      ).resolves.toBe('local-token\n');
      const config = JSON.parse(
        await fs.readFile(path.join(homeDir, 'profiles/local/config.json'), 'utf8'),
      ) as { daemon: { listen: string; server: { url: string } } };
      expect(config.daemon.listen).toBe('127.0.0.1:19990');
      expect(config.daemon.server.url).toBe('https://api.getviewport.test');
      const binding = await fs.readFile(path.join(repoDir, '.viewport/local.yaml'), 'utf8');
      expect(binding).toContain('profile: local');
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('sets a default profile for later commands', async () => {
    const registry = {
      version: 1,
      profiles: {
        prod: {
          name: 'prod',
          home: path.join(homeDir, 'profiles/prod'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    };
    await fs.writeFile(path.join(homeDir, 'profiles.json'), `${JSON.stringify(registry)}\n`);
    process.argv = ['node', 'vpd', 'profile', 'use', 'prod', '--json'];

    const { profile } = await import('../../src/cli/profile-command.js');
    await profile();

    await expect(fs.readFile(path.join(homeDir, 'current-profile'), 'utf8')).resolves.toBe(
      'prod\n',
    );
  });

  it('prints shell-scoped profile exports', async () => {
    process.argv = ['node', 'vpd', 'profile', 'env', 'prod'];

    const { profile } = await import('../../src/cli/profile-command.js');
    await profile();

    expect(logSpy.mock.calls.at(-1)?.[0]).toBe("export VPD_PROFILE='prod'");
  });

  it('lists profile daemon process state without switching profiles', async () => {
    const profileHome = path.join(homeDir, 'profiles/prod');
    await fs.mkdir(profileHome, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, 'profiles.json'),
      `${JSON.stringify({
        version: 1,
        profiles: {
          prod: {
            name: 'prod',
            home: profileHome,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(profileHome, 'daemon-state.json'),
      `${JSON.stringify({
        ownerPid: 99999999,
        workerPid: 99999998,
        host: '127.0.0.1',
        port: 7071,
        listen: '127.0.0.1:7071',
      })}\n`,
    );
    process.argv = ['node', 'vpd', 'profile', 'ps', '--json'];

    const { profile } = await import('../../src/cli/profile-command.js');
    await profile();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      profiles: Array<{ profile: string; running: boolean; listen: string }>;
    };
    expect(payload.profiles).toEqual([
      expect.objectContaining({
        profile: 'prod',
        running: false,
        listen: '127.0.0.1:7071',
      }),
    ]);
  });
});
