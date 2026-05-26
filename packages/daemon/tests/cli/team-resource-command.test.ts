import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('team-resource CLI command', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-team-resource-cli-'));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('syncs a Team Resource export bundle into git and creates a commit', async () => {
    const repo = path.join(tempRoot, 'repo');
    const remote = path.join(tempRoot, 'remote.git');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    await fs.mkdir(remote, { recursive: true });
    await git(remote, ['init', '--bare']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await fs.mkdir(path.join(repo, '.viewport/workflows'), { recursive: true });
    await fs.writeFile(path.join(repo, '.viewport/stale.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(repo, '.viewport/workflows/stale.json'), '{}\n', 'utf8');
    const bundlePath = path.join(tempRoot, 'bundle.json');
    const teamJson =
      JSON.stringify(
        {
          schema: 'viewport.team-resource/v1',
          team: { id: 'team_pub_1', name: 'Platform' },
        },
        null,
        2,
      ) + '\n';
    const workflowIndex =
      JSON.stringify(
        {
          schema: 'viewport.workflow-definitions-index/v1',
          data: [{ name: 'linear-triage', latest_version: { digest: 'sha256:workflow' } }],
        },
        null,
        2,
      ) + '\n';
    const bundle = {
      bundle_digest: 'sha256:bundle-proof',
      files: [
        fileEntry('.viewport/team.json', teamJson),
        fileEntry('.viewport/workflows/definitions.json', workflowIndex),
      ],
    };
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf8');

    await runTeamResource([
      'team-resource',
      'sync',
      '--bundle',
      bundlePath,
      '--repo',
      repo,
      '--commit-message',
      'Sync Viewport Team Resource',
      '--push',
      '--branch',
      'main',
      '--json',
    ]);

    await expect(fs.readFile(path.join(repo, '.viewport/team.json'), 'utf8')).resolves.toBe(
      teamJson,
    );
    await expect(
      fs.readFile(path.join(repo, '.viewport/workflows/definitions.json'), 'utf8'),
    ).resolves.toBe(workflowIndex);
    await expect(fs.stat(path.join(repo, '.viewport/stale.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(repo, '.viewport/workflows/stale.json'))).rejects.toThrow();
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const log = await git(repo, ['log', '-1', '--pretty=%s']);
    const remoteHead = await git(repo, ['ls-remote', 'origin', 'refs/heads/main']);
    const output = JSON.parse(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')) as Record<
      string,
      unknown
    >;

    expect(log.stdout.trim()).toBe('Sync Viewport Team Resource');
    expect(remoteHead.stdout).toContain(head.stdout.trim());
    expect(output).toMatchObject({
      schema_version: 'viewport.team_resource_sync/v1',
      command: 'team-resource sync',
      ok: true,
      repo,
      bundle_digest: 'sha256:bundle-proof',
      manifest_authoritative: true,
      commit: {
        created: true,
        status: 'committed',
        sha: head.stdout.trim(),
      },
      push: {
        pushed: true,
        remote: 'origin',
        branch: 'main',
      },
    });
    expect(output['files']).toEqual([
      expect.objectContaining({ path: '.viewport/team.json' }),
      expect.objectContaining({ path: '.viewport/workflows/definitions.json' }),
    ]);
    expect(output['deleted_files']).toEqual([
      '.viewport/stale.json',
      '.viewport/workflows/stale.json',
    ]);
  });

  it('rejects unsafe bundle paths before writing to disk', async () => {
    const repo = path.join(tempRoot, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    const bundlePath = path.join(tempRoot, 'unsafe-bundle.json');
    await fs.writeFile(
      bundlePath,
      JSON.stringify({
        files: [fileEntry('../secrets.txt', 'nope\n')],
      }),
      'utf8',
    );

    await expect(
      runTeamResource(['team-resource', 'sync', '--bundle', bundlePath, '--repo', repo, '--json']),
    ).rejects.toThrow('Unsafe Team Resource bundle path');
    await expect(fs.stat(path.join(tempRoot, 'secrets.txt'))).rejects.toThrow();
  });

  it('fetches a worker bundle from the API and reports the resulting commit', async () => {
    const repo = path.join(tempRoot, 'remote-repo');
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ['init']);
    const teamJson =
      JSON.stringify(
        {
          schema: 'viewport.team-resource/v1',
          team: { id: 'team_pub_remote', name: 'Remote team' },
        },
        null,
        2,
      ) + '\n';
    const bundle = {
      bundle_digest: 'sha256:remote-bundle-proof',
      repository_url: 'https://github.com/acme/team-resource.git',
      default_branch: 'main',
      files: [fileEntry('.viewport/team.json', teamJson)],
    };
    const reports: Array<Record<string, unknown>> = [];
    const seen = { bundleAuth: '', reportAuth: '' };
    const server = http.createServer((request, response) => {
      if (
        request.method === 'GET' &&
        request.url ===
          '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/team-resources/team_resource_1/export-bundle'
      ) {
        seen.bundleAuth = request.headers.authorization ?? '';
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: bundle }));
        return;
      }
      if (
        request.method === 'PATCH' &&
        request.url ===
          '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/team-resources/team_resource_1/sync-report'
      ) {
        seen.reportAuth = request.headers.authorization ?? '';
        let raw = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          raw += chunk;
        });
        request.on('end', () => {
          reports.push(JSON.parse(raw) as Record<string, unknown>);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: { sync_status: 'ready' } }));
        });
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'not found' }));
    });
    await listen(server);

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No server address');
      await runTeamResource([
        'team-resource',
        'sync',
        '--server',
        `http://127.0.0.1:${address.port}`,
        '--workspace',
        'workspace_1',
        '--executor',
        'executor_1',
        '--credential',
        'vpexec_test',
        '--resource',
        'team_resource_1',
        '--repo',
        repo,
        '--json',
      ]);
    } finally {
      await close(server);
    }

    await expect(fs.readFile(path.join(repo, '.viewport/team.json'), 'utf8')).resolves.toBe(
      teamJson,
    );
    expect(seen.bundleAuth).toBe('Bearer vpexec_test');
    expect(seen.reportAuth).toBe('Bearer vpexec_test');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      bundle_digest: 'sha256:remote-bundle-proof',
      branch: 'main',
      status: 'synced',
      pushed: false,
      remote_url: 'https://github.com/acme/team-resource.git',
      files: [
        { path: '.viewport/team.json', sha256: fileEntry('.viewport/team.json', teamJson).sha256 },
      ],
    });
    expect(String(reports[0]?.['commit_sha'])).toMatch(/^[a-f0-9]{40}$/);
    const output = JSON.parse(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')) as Record<
      string,
      unknown
    >;
    expect(output['api_report']).toEqual({
      reported: true,
      sync_status: 'ready',
    });
  });
});

async function runTeamResource(args: string[]): Promise<void> {
  process.argv = ['node', 'vpd', ...args];
  const { teamResource } = await import('../../src/cli/team-resource-command.js');
  await teamResource();
}

function fileEntry(
  filePath: string,
  content: string,
): { path: string; content: string; sha256: string; bytes: number } {
  return {
    path: filePath,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  };
}

function git(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    import('node:child_process')
      .then(({ spawn }) => {
        const child = spawn('git', ['-C', repo, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout || code}`));
        });
      })
      .catch(reject);
  });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
