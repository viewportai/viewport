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
    daemonPort: 7070,
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

    // Check the command format
    const sessionStartHook = settings.hooks.SessionStart[0].hooks[0];
    expect(sessionStartHook.command).toContain('--viewport-hook');
    expect(sessionStartHook.command).toContain('--event SessionStart');
    expect(sessionStartHook.command).toContain('--port 7070');

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

  it('updates on reinstall with different port', async () => {
    await installer.install(defaultConfig);
    const changed = await installer.install({ ...defaultConfig, daemonPort: 8080 });
    expect(changed).toBe(true);

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf-8'),
    );

    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('--port 8080');
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
});
