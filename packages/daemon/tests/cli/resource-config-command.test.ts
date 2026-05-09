import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('resource config CLI command', () => {
  const originalArgv = process.argv.slice();
  const originalTempHome = process.env['VPD_TEST_TEMP_HOME'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-resource-config-cli-'));
    process.env['VPD_TEST_TEMP_HOME'] = tempHome;
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalTempHome === undefined) {
      delete process.env['VPD_TEST_TEMP_HOME'];
    } else {
      process.env['VPD_TEST_TEMP_HOME'] = originalTempHome;
    }
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

  it('prints a provider-aware contract manifest for yaml configs', async () => {
    const repo = path.join(tempHome, 'contract-repo');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: docs',
        '      provider: repo-docs',
        '      paths: [CLAUDE.md]',
        '    - id: vault',
        '      provider: viewport-vault',
        '      vault: ctx_demo',
        'workflows:',
        '  review: .viewport/workflows/review.yaml',
        '',
      ].join('\n'),
    );

    await runContract(['contract', 'resolve', '--path', repo, '--json']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "contract resolve"');
    expect(output).toContain('"provider": "repo-docs"');
    expect(output).toContain('"provider": "viewport-vault"');
    expect(output).toContain('"vault": "ctx_demo"');
    expect(output).toContain('"path": ".viewport/workflows/review.yaml"');
  });

  it('authorizes a resolved contract against the runtime control-plane route', async () => {
    const repo = await writeContractRepo('authorized-contract', 'ctx_authorized');
    const server = await startAuthorizationServer({
      schema: 'viewport.resource_authorization/v1',
      manifest_digest: 'sha256:test',
      providers: [
        {
          id: 'vault',
          provider: 'viewport-vault',
          status: 'allowed',
          resource_type: 'context_vault',
          resource_ulid: 'ctx_authorized',
        },
      ],
      resources: [],
      summary: { allowed: 1, denied: 0, local: 0, delegated: 0 },
    });

    try {
      await runContract([
        'contract',
        'authorize',
        '--path',
        repo,
        '--server-url',
        server.url,
        '--workspace',
        'workspace_demo',
        '--credential',
        'runtime-secret',
        '--json',
      ]);
    } finally {
      await server.close();
    }

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe(
      '/api/runtime/workspaces/workspace_demo/contract/authorize',
    );
    expect(server.requests[0]?.body).toMatchObject({
      credential: 'runtime-secret',
      resource_manifest: {
        schema: 'viewport.session_resource_manifest/v1',
        contract: {
          contextProviders: [
            expect.objectContaining({ provider: 'viewport-vault', vault: 'ctx_authorized' }),
          ],
        },
      },
    });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "contract authorize"');
    expect(output).toContain('"ok": true');
    expect(output).toContain('"schema": "viewport.resource_authorization/v1"');
  });

  it('fails contract authorization when required resources are denied', async () => {
    const repo = await writeContractRepo('denied-contract', 'ctx_denied');
    const server = await startAuthorizationServer({
      schema: 'viewport.resource_authorization/v1',
      manifest_digest: 'sha256:test',
      providers: [
        {
          id: 'vault',
          provider: 'viewport-vault',
          status: 'denied',
          reason: 'permission_denied',
          resource_type: 'context_vault',
          resource_ulid: 'ctx_denied',
        },
      ],
      resources: [],
      summary: { allowed: 0, denied: 1, local: 0, delegated: 0 },
    });

    try {
      await expect(
        runContract([
          'contract',
          'authorize',
          '--path',
          repo,
          '--server-url',
          server.url,
          '--workspace',
          'workspace_demo',
          '--credential',
          'runtime-secret',
          '--json',
        ]),
      ).rejects.toThrow('Viewport contract authorization denied 1 item(s)');
    } finally {
      await server.close();
    }

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "contract authorize"');
    expect(output).toContain('"ok": false');
    expect(output).toContain('"reason": "permission_denied"');
  });

  it('validates repo contracts and reports invalid configs', async () => {
    const repo = path.join(tempHome, 'invalid-contract');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: broken',
        '      provider: unknown',
      ].join('\n'),
    );

    await runValidate(['validate', '--path', repo, '--json']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "validate"');
    expect(output).toContain('"ok": false');
    expect(output).toContain('"code": "invalid_config_skipped"');
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

async function runContract(args: string[]): Promise<void> {
  process.argv = ['node', 'vpd', ...args];
  const { contract } = await import('../../src/cli/resource-config-command.js');
  await contract();
}

async function runValidate(args: string[]): Promise<void> {
  process.argv = ['node', 'vpd', ...args];
  const { validate } = await import('../../src/cli/resource-config-command.js');
  await validate();
}

async function writeContractRepo(name: string, vaultId: string): Promise<string> {
  const repo = path.join(tempRoot(), name);
  await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.viewport', 'config.yaml'),
    [
      'version: 1',
      'context:',
      '  providers:',
      '    - id: vault',
      '      provider: viewport-vault',
      `      vault: ${vaultId}`,
      '',
    ].join('\n'),
  );
  return repo;
}

function tempRoot(): string {
  const current = process.env['VPD_TEST_TEMP_HOME'];
  if (typeof current !== 'string' || current.length === 0) {
    throw new Error('VPD_TEST_TEMP_HOME not set');
  }
  return current;
}

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  body: Record<string, unknown>;
}

async function startAuthorizationServer(data: Record<string, unknown>): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('authorization server did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
