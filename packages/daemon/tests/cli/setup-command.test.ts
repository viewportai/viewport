import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySetupFlagOverrides,
  ensureManagedProfileForSetup,
  parseLingerValue,
  recommendedSetupPlan,
  resolveInstallUserForLinger,
} from '../../src/cli/setup-command.js';

describe('setup command planning', () => {
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalViewportProfile = process.env['VIEWPORT_PROFILE'];
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-setup-profile-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    if (originalViewportProfile) process.env['VIEWPORT_PROFILE'] = originalViewportProfile;
    else delete process.env['VIEWPORT_PROFILE'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('returns recommended defaults', () => {
    expect(recommendedSetupPlan()).toEqual({
      recommended: true,
      installService: false,
      installPrereqs: false,
      installHooks: false,
    });
  });

  it('applies power-user no-* overrides', () => {
    const plan = applySetupFlagOverrides(recommendedSetupPlan(), [
      'setup',
      '--no-service',
      '--no-prereqs',
      '--no-hooks',
    ]);
    expect(plan.installService).toBe(false);
    expect(plan.installPrereqs).toBe(false);
    expect(plan.installHooks).toBe(false);
  });

  it('resolves install user for linger checks', () => {
    expect(resolveInstallUserForLinger({ SUDO_USER: 'rooted', USER: 'regular' })).toBe('rooted');
    expect(resolveInstallUserForLinger({ USER: 'regular' })).toBe('regular');
    expect(resolveInstallUserForLinger({})).toBeNull();
  });

  it('parses loginctl linger values', () => {
    expect(parseLingerValue('yes\n')).toBe(true);
    expect(parseLingerValue('no')).toBe(false);
    expect(parseLingerValue('unknown')).toBeNull();
  });

  it('creates and selects prod profile on first managed setup', async () => {
    const result = await ensureManagedProfileForSetup();
    expect(result).toEqual({ profileName: 'prod', created: true, selected: true });
    await expect(fs.readFile(path.join(homeDir, 'current-profile'), 'utf8')).resolves.toBe(
      'prod\n',
    );
    const config = JSON.parse(
      await fs.readFile(path.join(homeDir, 'profiles/prod/config.json'), 'utf8'),
    ) as { daemon: { server: { url: string; appUrl: string }; relay: { endpoint: string } } };
    expect(config.daemon.server.url).toBe('https://api.getviewport.com');
    expect(config.daemon.server.appUrl).toBe('https://app.getviewport.com');
    expect(config.daemon.relay.endpoint).toBe('wss://relay.getviewport.com/ws');
  });

  it('does not override an explicitly scoped setup profile', async () => {
    process.env['VIEWPORT_PROFILE'] = 'local';
    const result = await ensureManagedProfileForSetup();
    expect(result).toEqual({ profileName: 'local', created: false, selected: false });
    await expect(fs.stat(path.join(homeDir, 'current-profile'))).rejects.toThrow();
  });
});
