import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('resource config CLI command', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-resource-config-cli-'));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('prints a resolved resource manifest for a repo config', async () => {
    const repo = path.join(tempHome, 'repo');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.json'),
      JSON.stringify({
        version: 1,
        resources: {
          contexts: ['ctx_demo'],
          workflows: ['wf_demo'],
        },
      }),
    );

    await runConfig(['config', 'resolve', '--cwd', repo, '--json']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "config resolve"');
    expect(output).toContain('"viewport.session_resource_manifest/v1"');
    expect(output).toContain('ctx_demo');
    expect(output).toContain('wf_demo');
  });

  it('prints a human-readable doctor report with resolved resource ids', async () => {
    const repo = path.join(tempHome, 'repo-doctor');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.json'),
      JSON.stringify({
        version: 1,
        resources: {
          contexts: [{ id: 'ctx_required', required: true }],
          workflows: ['wf_release'],
          plans: ['plan_launch'],
        },
      }),
    );

    await runConfig(['config', 'doctor', '--cwd', repo]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Viewport config doctor');
    expect(output).toContain('Status:      ready');
    expect(output).toContain('Contexts:');
    expect(output).toContain('ctx_required (required)');
    expect(output).toContain('wf_release');
    expect(output).toContain('plan_launch');
  });

  it('marks missing repo config as needing attention', async () => {
    const repo = path.join(tempHome, 'unconfigured');
    await fs.mkdir(repo, { recursive: true });

    await runConfig(['config', 'doctor', '--cwd', repo, '--json']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "config doctor"');
    expect(output).toContain('"ok": false');
    expect(output).toContain('"status": "needs_attention"');
    expect(output).toContain('no_config_found');
  });
});

async function runConfig(args: string[]): Promise<void> {
  process.argv = ['node', 'vpd', ...args];
  const { config } = await import('../../src/cli/resource-config-command.js');
  await config();
}
