import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_POLICY = `
version: 1
agent: viewport-default
repos:
  - repo: acme/backend
    access: read-write
invoke:
  notify:
    provider: slack
    credential_ref: slack/support
    channel: C123
`.trim();

const INVALID_POLICY_BAD_REPO = `
version: 1
agent: viewport-default
repos:
  - repo: not-valid-format
    access: read-write
`.trim();

const INVALID_POLICY_TYPO_STRICT = `
version: 1
agent: viewport-default
repos:
  - repo: acme/backend
    access: read-write
    branches:
      restrcited: [main]
`.trim();

const VALID_ROUTE = `
route:
  name: backend-jira
  team: backend
  trigger:
    integration: jira
    events: [issue_updated]
  policy:
    source: git
    repo: acme/backend
`.trim();

const VALID_SLACK_ROUTE_WITH_MENTION = `
route:
  name: slack-support
  team: platform
  trigger:
    integration: slack
    events: [app_mention]
    conditions:
      channel: C1234567890
      mentionsAny:
        - viewport
  policy:
    source: git
    repo: acme/backend
    ref: main
    path: .viewport/policy.yaml
  priority: 30
`.trim();

const INVALID_ROUTE_BAD_NAME = `
route:
  name: BackendJira
  team: backend
  trigger:
    integration: jira
    events: [issue_updated]
  policy:
    source: git
    repo: acme/backend
`.trim();

describe('check-command', () => {
  let tmpDir: string;
  let stdoutLines: string[];
  let stderrLines: string[];
  let exitCode: number | null;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalArgv = process.argv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-check-test-'));
    await fs.mkdir(path.join(tmpDir, '.viewport'));

    stdoutLines = [];
    stderrLines = [];
    exitCode = null;

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    });

    vi.resetModules();
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = originalArgv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runCheck(args: string[] = []): Promise<void> {
    process.argv = ['node', 'vpd', 'check', ...args];
    vi.resetModules();
    const { check } = await import('../../src/cli/check-command.js');
    await check().catch((e: Error) => {
      if (!e.message.startsWith('process.exit')) throw e;
    });
  }

  it('exits 0 and prints ✓ for a valid policy.yaml', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await runCheck([tmpDir]);

    expect(exitCode).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('✓');
    expect(out).toContain('policy.yaml');
  });

  it('exits 1 and prints specific errors for an invalid policy.yaml', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), INVALID_POLICY_BAD_REPO);
    await runCheck([tmpDir]);

    expect(exitCode).toBe(1);
    const out = stdoutLines.join('');
    expect(out).toContain('✗');
    expect(out).toContain('error');
  });

  it('catches strict-mode typo (restrcited) and reports it as an error', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), INVALID_POLICY_TYPO_STRICT);
    await runCheck([tmpDir]);

    expect(exitCode).toBe(1);
    const out = stdoutLines.join('');
    expect(out).toContain('✗');
    // The error must mention the typo'd field
    expect(out).toMatch(/restrcited|Unrecognized/i);
  });

  it('exits 1 when .viewport/ directory does not exist', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-no-viewport-'));
    try {
      await runCheck([emptyDir]);
      expect(exitCode).toBe(1);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('works with an explicit path argument', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await runCheck([tmpDir]);

    expect(exitCode).toBe(0);
    expect(stdoutLines.join('')).toContain(tmpDir);
  });

  it('validates routes/*.yaml files', async () => {
    await fs.mkdir(path.join(tmpDir, '.viewport', 'routes'));
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await fs.writeFile(path.join(tmpDir, '.viewport', 'routes', 'backend.yaml'), VALID_ROUTE);
    await runCheck([tmpDir]);

    expect(exitCode).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('routes/backend.yaml');
    expect(out).toContain('✓');
  });

  it('validates Slack routes with mention conditions', async () => {
    await fs.mkdir(path.join(tmpDir, '.viewport', 'routes'));
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await fs.writeFile(
      path.join(tmpDir, '.viewport', 'routes', 'slack-support.yaml'),
      VALID_SLACK_ROUTE_WITH_MENTION,
    );
    await runCheck([tmpDir]);

    expect(exitCode).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('routes/slack-support.yaml');
    expect(out).toContain('✓');
  });

  it('reports route validation errors', async () => {
    await fs.mkdir(path.join(tmpDir, '.viewport', 'routes'));
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await fs.writeFile(
      path.join(tmpDir, '.viewport', 'routes', 'bad.yaml'),
      INVALID_ROUTE_BAD_NAME,
    );
    await runCheck([tmpDir]);

    expect(exitCode).toBe(1);
    const out = stdoutLines.join('');
    expect(out).toContain('✗');
    expect(out).toContain('routes/bad.yaml');
  });

  it('outputs machine-readable JSON with --json flag', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await runCheck([tmpDir, '--json']);

    expect(exitCode).toBe(0);
    const raw = stdoutLines.join('');
    const parsed = JSON.parse(raw) as { valid: boolean; results: unknown[] };
    expect(parsed.valid).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('warns when .viewport is ignored by git', async () => {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.viewport/\n');
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await runCheck([tmpDir]);

    expect(exitCode).toBe(0);
    expect(stdoutLines.join('')).toContain('.viewport/ appears to be ignored by git');
  });

  it('includes gitignore warnings in JSON output', async () => {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '.viewport/\n');
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await runCheck([tmpDir, '--json']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutLines.join('')) as { warningCount: number; warnings: string[] };
    expect(parsed.warningCount).toBe(1);
    expect(parsed.warnings[0]).toContain('.viewport/ appears to be ignored by git');
  });

  it('--json outputs valid=false and error list for invalid policy', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), INVALID_POLICY_BAD_REPO);
    await runCheck([tmpDir, '--json']);

    expect(exitCode).toBe(1);
    const raw = stdoutLines.join('');
    const parsed = JSON.parse(raw) as { valid: boolean; errorCount: number };
    expect(parsed.valid).toBe(false);
    expect(parsed.errorCount).toBeGreaterThan(0);
  });

  it('validates access.yaml structure when present', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await fs.writeFile(
      path.join(tmpDir, '.viewport', 'access.yaml'),
      'grants:\n  read-write:\n    teams: [backend]\n',
    );
    await runCheck([tmpDir]);

    expect(exitCode).toBe(0);
    expect(stdoutLines.join('')).toContain('access.yaml');
  });

  it('rejects access.yaml without a grants key', async () => {
    await fs.writeFile(path.join(tmpDir, '.viewport', 'policy.yaml'), VALID_POLICY);
    await fs.writeFile(path.join(tmpDir, '.viewport', 'access.yaml'), 'teams:\n  - backend\n');
    await runCheck([tmpDir]);

    expect(exitCode).toBe(1);
    expect(stdoutLines.join('')).toContain('✗');
  });

  it('exits 1 with no files in .viewport/', async () => {
    await runCheck([tmpDir]);
    expect(exitCode).toBe(1);
  });
});
