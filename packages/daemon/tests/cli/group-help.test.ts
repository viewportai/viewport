import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('grouped CLI command help', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-group-help-'));
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  const commands = [
    ['daemon'],
    ['context'],
    ['remote'],
    ['permit'],
    ['worktree'],
    ['workflow'],
    ['config'],
    ['contract'],
    ['agent'],
    ['service'],
    ['session'],
    ['hook'],
    ['daemon', 'service'],
  ];

  for (const command of commands) {
    it(`prints stdout help and exits 0 for vpd ${command.join(' ')}`, async () => {
      const result = await exec(tsxBin(), ['src/index.ts', ...command], {
        cwd: packageRoot(),
        env: {
          ...process.env,
          VIEWPORT_HOME: tempHome,
        },
      });

      expect(result.stdout).toContain('Usage:');
      expect(result.stderr).toBe('');
    });
  }
});

function packageRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

function tsxBin(): string {
  return path.resolve(
    packageRoot(),
    '..',
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
}
