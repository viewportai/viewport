import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('context CLI command', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-cli-'));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('initializes, adds, and resolves local context through vpd arguments', async () => {
    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--project',
      'project-alpha',
      '--user',
      'alice',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "context init"'));
    logSpy.mockClear();

    await runContext([
      'context',
      'add',
      '--home',
      tempHome,
      '--project',
      'project-alpha',
      '--device',
      'alice-laptop',
      '--title',
      'Testing policy',
      '--body',
      'Every bug fix needs a regression test.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "context add"'));
    logSpy.mockClear();

    const { writeContextProfile } = await import('../../src/context/local-edge-store.js');
    const profile = await writeContextProfile({
      projectId: 'project-alpha',
      name: 'code-review',
      packs: ['project-standards'],
      query: 'regression',
      maxItems: 1,
      credentials: {
        passphrase: 'alice-passphrase',
        recoveryCode: 'alice-recovery',
      },
      home: tempHome,
    });

    await runContext([
      'context',
      'resolve',
      '--home',
      tempHome,
      '--project',
      'project-alpha',
      '--device',
      'alice-laptop',
      '--query',
      'regression',
      '--profile',
      profile.path,
      '--profile-path',
      profile.path,
      '--profile-digest',
      profile.digest,
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context resolve"');
    expect(output).toContain('"serverSync": "disabled"');
    expect(output).toContain('"viewport.context_bundle_manifest/v1"');
    expect(output).toContain(profile.digest);
    expect(output).toContain('Every bug fix needs a regression test.');
  });

  async function runContext(args: string[]): Promise<void> {
    process.argv = ['node', 'vpd', ...args];
    vi.resetModules();
    const { context } = await import('../../src/cli/context-command.js');
    await context();
  }
});
