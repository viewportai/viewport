import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeHookInstaller } from '../../src/hooks/installers/claude.js';
import { HOOK_EVENT_KINDS } from '../../src/hooks/types.js';

describe('ClaudeHookInstaller', () => {
  let tempHome: string;
  let originalHome: string;
  let installer: ClaudeHookInstaller;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hooks-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;
    installer = new ClaudeHookInstaller();
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  const defaultConfig = {
    vpdBinaryPath: '/usr/local/bin/vpd',
    daemonListen: '127.0.0.1:7070',
    events: [...HOOK_EVENT_KINDS],
  };

  it('has adapter name', () => {
    expect(installer.adapterName).toBe('Claude Code');
  });

  it('installs hooks into new settings file', async () => {
    const changed = await installer.install(defaultConfig);
    expect(changed).toBe(true);
    const settingsPath = path.join(tempHome, '.claude', 'settings.json');

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(settings.hooks.PlanProposed).toBeUndefined();

    // Check the command format
    const sessionStartHook = settings.hooks.SessionStart[0].hooks[0];
    expect(sessionStartHook.command).toContain('--viewport-hook');
    expect(sessionStartHook.command).toContain('--event SessionStart');
    expect(sessionStartHook.command).toContain("--listen '127.0.0.1:7070'");

    // PermissionRequest should have longer timeout
    const permHook = settings.hooks.PermissionRequest[0].hooks[0];
    expect(permHook.timeout).toBe(120);

    // Other hooks have short timeout
    expect(sessionStartHook.timeout).toBe(5);

    const stat = await fs.stat(settingsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('preserves existing user hooks', async () => {
    const claudeDir = path.join(tempHome, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'my-custom-hook' }] }],
        },
        otherSetting: true,
      }),
    );

    await installer.install(defaultConfig);

    const settings = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf-8'));

    // User hook preserved
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('my-custom-hook');
    expect(settings.hooks.SessionStart[1].hooks[0].command).toContain('--viewport-hook');

    // Other settings preserved
    expect(settings.otherSetting).toBe(true);
  });

  it('is idempotent — no changes on reinstall', async () => {
    await installer.install(defaultConfig);
    const changed = await installer.install(defaultConfig);
    expect(changed).toBe(false);
  });

  it('updates on reinstall with different listen target', async () => {
    await installer.install(defaultConfig);
    const changed = await installer.install({ ...defaultConfig, daemonListen: '127.0.0.1:8080' });
    expect(changed).toBe(true);

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain("--listen '127.0.0.1:8080'");
  });

  it('quotes vpd paths with spaces', async () => {
    await installer.install({
      ...defaultConfig,
      vpdBinaryPath: '/Users/mehr/Library/Application Support/Herd/bin/vpd',
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain("'/Users/mehr/Library/Application Support/Herd/bin/vpd'");
    expect(cmd).toContain("--listen '127.0.0.1:7070'");
  });

  it('quotes dev tsx entrypoints without breaking the command prefix', async () => {
    await installer.install({
      ...defaultConfig,
      vpdBinaryPath: 'npx tsx /Users/mehr/Herd/viewportai/viewport/packages/daemon/src/index.ts',
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain(
      "npx tsx '/Users/mehr/Herd/viewportai/viewport/packages/daemon/src/index.ts'",
    );
  });

  it('quotes local node js entrypoints without requiring executable file mode', async () => {
    await installer.install({
      ...defaultConfig,
      vpdBinaryPath: 'node /Users/mehr/Herd/viewportai/viewport/packages/daemon/dist/index.js',
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain(
      "node '/Users/mehr/Herd/viewportai/viewport/packages/daemon/dist/index.js'",
    );
  });

  it('isInstalled detects installed hooks', async () => {
    expect(await installer.isInstalled()).toBe(false);
    await installer.install(defaultConfig);
    expect(await installer.isInstalled()).toBe(true);
  });

  it('uninstall removes viewport hooks', async () => {
    await installer.install(defaultConfig);
    const changed = await installer.uninstall();
    expect(changed).toBe(true);

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    // All hook event arrays should be removed (they were viewport-only)
    expect(Object.keys(settings.hooks ?? {}).length).toBe(0);
    expect(await installer.isInstalled()).toBe(false);
  });

  it('uninstall preserves user hooks', async () => {
    const claudeDir = path.join(tempHome, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'my-custom-hook' }] }],
        },
      }),
    );

    await installer.install(defaultConfig);
    await installer.uninstall();

    const settings = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf-8'));

    // User hook preserved, viewport hook removed
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('my-custom-hook');
  });

  it('uninstall is safe when no settings file', async () => {
    const changed = await installer.uninstall();
    expect(changed).toBe(false);
  });

  it('installs only specified events', async () => {
    await installer.install({
      ...defaultConfig,
      events: ['SessionStart', 'PermissionRequest'],
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeUndefined();
    expect(settings.hooks.Notification).toBeUndefined();
  });

  it('does not install Claude-unsupported internal events', async () => {
    await installer.install({
      ...defaultConfig,
      events: ['Stop', 'PlanProposed'],
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.PlanProposed).toBeUndefined();
  });

  it('removes stale viewport hooks from unsupported events on reinstall', async () => {
    const claudeDir = path.join(tempHome, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PlanProposed: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/local/bin/vpd hook notify --event PlanProposed --viewport-hook',
                },
              ],
            },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }],
        },
      }),
    );

    await installer.install(defaultConfig);

    const settings = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.hooks.PlanProposed).toBeUndefined();
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('user-stop-hook');
    expect(settings.hooks.Stop[1].hooks[0].command).toContain('--viewport-hook');
  });

  it('removes stale exec-form viewport hooks on reinstall', async () => {
    const claudeDir = path.join(tempHome, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/local/bin/vpd',
                  args: [
                    'hook',
                    'notify',
                    '--event',
                    'Stop',
                    '--port',
                    '7070',
                    '--viewport-hook',
                  ],
                },
              ],
            },
          ],
        },
      }),
    );

    await installer.install(defaultConfig);

    const settings = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("--listen '127.0.0.1:7070'");
    expect(settings.hooks.Stop[0].hooks[0].args).toBeUndefined();
  });
});
