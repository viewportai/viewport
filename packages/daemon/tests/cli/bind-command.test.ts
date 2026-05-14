import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

describe('bind CLI command', () => {
  const originalArgv = process.argv.slice();
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalViewportProfile = process.env['VIEWPORT_PROFILE'];
  const originalCwd = process.cwd();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  let homeDir = '';
  let repoDir = '';

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-bind-home-'));
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-bind-repo-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
    process.chdir(repoDir);
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    if (originalViewportProfile) process.env['VIEWPORT_PROFILE'] = originalViewportProfile;
    else delete process.env['VIEWPORT_PROFILE'];
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('writes a gitignored local organization binding from an explicit org id', async () => {
    process.argv = ['node', 'vpd', 'bind', '.', '--org', '01ORG', '--json'];

    const { bind } = await import('../../src/cli/bind-command.js');
    await bind();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      organizationId: string;
      localConfig: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.organizationId).toBe('01ORG');

    const local = YAML.parse(await fs.readFile(path.join(repoDir, '.viewport/local.yaml'), 'utf8'));
    expect(local.organization_id).toBe('01ORG');
    expect(local.profile).toBe('default');
    expect(local.remote.stream).toBe('enabled');
    await expect(
      fs.readFile(path.join(repoDir, '.viewport/.gitignore'), 'utf8'),
    ).resolves.toContain('/local.yaml');
    await expect(
      fs.readFile(path.join(repoDir, '.viewport/.gitignore'), 'utf8'),
    ).resolves.toContain('/hint-declines.json');
  });

  it('uses committed workspace hint when org id is omitted', async () => {
    await fs.mkdir(path.join(repoDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, '.viewport/workspace.yaml'),
      'version: 1\norganization_id: 01HINT\n',
    );
    process.argv = ['node', 'vpd', 'bind', '.', '--json'];

    const { bind } = await import('../../src/cli/bind-command.js');
    await bind();

    const local = YAML.parse(await fs.readFile(path.join(repoDir, '.viewport/local.yaml'), 'utf8'));
    expect(local.organization_id).toBe('01HINT');
  });

  it('refuses to replace an existing binding without --yes', async () => {
    process.argv = ['node', 'vpd', 'bind', '.', '--org', '01FIRST', '--json'];
    const { bind } = await import('../../src/cli/bind-command.js');
    await bind();

    vi.resetModules();
    process.argv = ['node', 'vpd', 'bind', '.', '--org', '01SECOND', '--json'];
    const { bind: bindAgain } = await import('../../src/cli/bind-command.js');
    await expect(bindAgain()).rejects.toThrow('Re-run with --yes');
  });

  it('records and enforces the active daemon profile on repo bindings', async () => {
    process.env['VIEWPORT_PROFILE'] = 'prod';
    process.argv = ['node', 'vpd', 'bind', '.', '--org', '01ORG', '--json'];

    const { bind } = await import('../../src/cli/bind-command.js');
    await bind();

    const local = YAML.parse(await fs.readFile(path.join(repoDir, '.viewport/local.yaml'), 'utf8'));
    expect(local.profile).toBe('prod');

    const { directoryStreamsToOrganization } = await import('../../src/cli/org-binding.js');
    expect(directoryStreamsToOrganization({ directory: repoDir, organizationId: '01ORG' })).toBe(
      true,
    );

    process.env['VIEWPORT_PROFILE'] = 'local';
    expect(directoryStreamsToOrganization({ directory: repoDir, organizationId: '01ORG' })).toBe(
      false,
    );

    vi.resetModules();
    process.argv = ['node', 'vpd', 'bind', '.', '--org', '01ORG', '--json'];
    const { bind: bindAgain } = await import('../../src/cli/bind-command.js');
    await expect(bindAgain()).rejects.toThrow('using profile "prod"');
  });

  it('records declined workspace hints as gitignored local-only state', async () => {
    const { recordWorkspaceOrgHintDecline, workspaceOrgHintDeclinedSync } =
      await import('../../src/cli/org-binding.js');

    await recordWorkspaceOrgHintDecline({ directory: repoDir, organizationId: '01HINT' });

    expect(workspaceOrgHintDeclinedSync({ directory: repoDir, organizationId: '01HINT' })).toBe(
      true,
    );
    expect(workspaceOrgHintDeclinedSync({ directory: repoDir, organizationId: '01OTHER' })).toBe(
      false,
    );
    await expect(
      fs.readFile(path.join(repoDir, '.viewport/.gitignore'), 'utf8'),
    ).resolves.toContain('/hint-declines.json');
  });
});
