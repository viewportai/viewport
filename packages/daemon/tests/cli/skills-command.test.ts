import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('skills CLI command', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-skills-cli-'));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('installs the Claude Code skill to an explicit target with a stable JSON receipt', async () => {
    const target = path.join(tempHome, 'viewport.md');

    await runSkills(['skills', 'install', 'claude-code', '--target', target, '--json']);

    const body = await fs.readFile(target, 'utf8');
    expect(body).toContain('Viewport Agent Contract');
    expect(body).toContain('vpd context search --path . --query');
    expect(body).toContain('vpd context add --provider');
    expect(body).toContain('vpd context propose --path . --title');
    expect(body).toContain('Viewport may inject approved repo context automatically');
    expect(body).toContain('vpd uses');
    expect(body).toContain('it automatically');
    expect(body).toContain('Use `context propose` for agent-learned suggestions');

    const output = parseLoggedJson(logSpy.mock.calls.map((call) => call.join(' ')).join('\n'));
    expect(output).toMatchObject({
      schema_version: 'viewport.cli.skills_install/v1',
      command: 'skills install',
      ok: true,
      installed: [
        {
          agent: 'claude-code',
          path: target,
          changed: true,
        },
      ],
      skipped: [],
    });
  });

  it('does not overwrite edited skill files unless forced', async () => {
    const target = path.join(tempHome, 'viewport.md');
    await fs.writeFile(target, 'custom user rules', 'utf8');

    await runSkills(['skills', 'install', 'claude-code', '--target', target, '--json']);

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('custom user rules');
    const output = parseLoggedJson(logSpy.mock.calls.map((call) => call.join(' ')).join('\n'));
    expect(output).toMatchObject({
      schema_version: 'viewport.cli.skills_install/v1',
      ok: false,
      installed: [],
      skipped: [
        {
          agent: 'claude-code',
          path: target,
          reason: 'exists_use_force_to_overwrite',
        },
      ],
    });
  });
});

async function runSkills(args: string[]): Promise<void> {
  process.argv = ['node', 'vpd', ...args];
  const { skills } = await import('../../src/cli/skills-command.js');
  await skills();
}

function parseLoggedJson(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}
