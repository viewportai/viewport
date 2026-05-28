import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('lifecycle update command', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    process.argv = originalArgv.slice();
    logSpy.mockClear();
    vi.resetModules();
  });

  it('prints explicit manual package-manager upgrade posture without running an update', async () => {
    process.argv = ['node', 'vpd', 'update', '--dry-run', '--json'];

    const { update } = await import('../../src/cli/lifecycle-update-command.js');
    await update();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      command: string;
      ok: boolean;
      dryRun: boolean;
      package: string;
      upgradePolicy: string;
      signedReleaseManifest: boolean;
      commandPlan: string[];
    };
    expect(payload).toMatchObject({
      command: 'update',
      ok: true,
      dryRun: true,
      package: '@viewportai/daemon',
      upgradePolicy: 'manual-package-manager',
      signedReleaseManifest: false,
      commandPlan: ['npm', 'install', '-g', '@viewportai/daemon@latest'],
    });
  });

  it('records restart intent in dry-run output', async () => {
    process.argv = ['node', 'vpd', 'update', '--dry-run', '--restart', '--json'];

    const { update } = await import('../../src/cli/lifecycle-update-command.js');
    await update();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      restartRequested: boolean;
    };
    expect(payload.restartRequested).toBe(true);
  });
});
