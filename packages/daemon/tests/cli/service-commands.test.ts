import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureServiceWorkingDirectory,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServiceWorkingDirectory,
  resolveServiceSubcommand,
} from '../../src/cli/service-commands.js';

describe('service commands', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-service-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  const spec = {
    nodePath: '/usr/local/bin/node',
    daemonEntryPath: '/opt/viewport/daemon/dist/index.js',
    cwd: '/work/project',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
  };

  it('renders launchd plist with foreground daemon start args', () => {
    const plist = renderLaunchdPlist('ai.viewport.daemon', spec);
    expect(plist).toContain('<string>ai.viewport.daemon</string>');
    expect(plist).not.toContain('<string>/bin/sh</string>');
    expect(plist).not.toContain('<string>-lc</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('/usr/local/bin/node');
    expect(plist).toContain('/opt/viewport/daemon/dist/index.js');
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('<string>--foreground</string>');
  });

  it('renders systemd unit with foreground daemon start args', () => {
    const unit = renderSystemdUnit('viewport-daemon.service', spec);
    expect(unit).toContain('Description=ViewportAI Daemon');
    expect(unit).toContain(
      'ExecStart=/usr/local/bin/node /opt/viewport/daemon/dist/index.js start --foreground',
    );
    expect(unit).toContain('Restart=always');
  });

  it('parses top-level service subcommands', () => {
    expect(resolveServiceSubcommand(['service', 'install'])).toBe('install');
    expect(resolveServiceSubcommand(['service', 'uninstall'])).toBe('uninstall');
    expect(resolveServiceSubcommand(['service'])).toBe('status');
  });

  it('parses nested daemon service subcommands', () => {
    expect(resolveServiceSubcommand(['daemon', 'service', 'install'])).toBe('install');
    expect(resolveServiceSubcommand(['daemon', 'service', 'status'])).toBe('status');
  });

  it('uses the daemon home as the service working directory', () => {
    expect(resolveServiceWorkingDirectory()).toContain('.viewport');
  });

  it('creates the service working directory before install', async () => {
    const cwd = await ensureServiceWorkingDirectory();
    const stat = await fs.stat(cwd);
    expect(stat.isDirectory()).toBe(true);
  });
});
