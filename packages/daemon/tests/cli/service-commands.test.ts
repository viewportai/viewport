import { describe, expect, it } from 'vitest';
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServiceSubcommand,
} from '../../src/cli/service-commands.js';

describe('service commands', () => {
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
});
