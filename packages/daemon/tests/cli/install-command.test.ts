import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('install command', () => {
  const originalHome = process.env['HOME'];
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalArgv = process.argv;
  let tempHome = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-install-command-'));
    process.env['HOME'] = tempHome;
    process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');
    process.argv = ['node', 'vpd', 'install'];
    vi.resetModules();
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    if (originalHome) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    process.argv = originalArgv;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('does not install hooks by default', async () => {
    const { install } = await import('../../src/cli/install-command.js');

    await install();

    await expect(fs.stat(path.join(tempHome, '.viewport'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tempHome, '.claude', 'settings.json'))).rejects.toThrow();
    expect(stdoutSpy.mock.calls.flat().join('\n')).toContain('Hooks: skipped');
  });

  it('installs hooks only when explicitly requested', async () => {
    const { install } = await import('../../src/cli/install-command.js');

    await install({ installHooks: true });

    const settings = JSON.parse(
      await fs.readFile(path.join(tempHome, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks?: Record<string, unknown> };
    expect(settings.hooks).toBeDefined();
    expect(JSON.stringify(settings.hooks)).toContain('--viewport-hook');
  });
});
