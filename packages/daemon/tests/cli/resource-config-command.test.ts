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
    const parsed = parseLoggedJson(output);
    expect(parsed).toMatchObject({
      schema_version: 'viewport.cli.contract_resolve/v1',
      command: 'contract resolve',
      ok: true,
      path: repo,
      resolver: {
        name: 'vpd-contract-resolver',
        version: '1',
      },
    });
    expect(parsed['manifest_digest']).toMatch(/^sha256:/);
    expect(parsed['config_files']).toEqual([
      expect.objectContaining({
        path: path.join(repo, '.viewport', 'config.yaml'),
        digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(parsed['providers']).toEqual([
      expect.objectContaining({
        id: 'docs',
        provider: 'repo-docs',
        privacy: 'local_only',
        status: 'available',
      }),
      expect.objectContaining({
        id: 'vault',
        provider: 'viewport-vault',
        vault: 'ctx_demo',
        status: 'available',
      }),
    ]);
    expect(parsed['workflows']).toEqual([
      expect.objectContaining({
        id: 'review',
        source: 'local_file',
        path: '.viewport/workflows/review.yaml',
        status: 'requested_unverified',
      }),
    ]);
    expect(output).toContain('"schema": "viewport.session_resource_manifest/v1"');
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
    const parsed = parseLoggedJson(output);
    expect(parsed).toMatchObject({
      schema_version: 'viewport.cli.validate/v1',
      command: 'validate',
      ok: false,
      status: 'needs_attention',
      path: repo,
      config_files: [],
      workflow_files: [],
    });
    expect(parsed['warnings']).toEqual([
      expect.objectContaining({ code: 'invalid_config_skipped' }),
    ]);
    expect(parsed['errors']).toEqual([expect.objectContaining({ code: 'invalid_config_skipped' })]);
  });

  it('rejects inline provider secrets and points users to credential handles', async () => {
    const repo = path.join(tempHome, 'inline-provider-secret');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: product-research',
        '      provider: notebooklm',
        '      notebook: nb_product',
        '      api_key: sk-do-not-commit',
      ].join('\n'),
    );

    await runValidate(['validate', '--path', repo, '--json']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const parsed = parseLoggedJson(output);
    expect(parsed).toMatchObject({
      schema_version: 'viewport.cli.validate/v1',
      command: 'validate',
      ok: false,
      status: 'needs_attention',
      config_files: [],
    });
    expect(JSON.stringify(parsed['errors'])).toContain(
      'Provider credentials must use credential_ref handles',
    );
    expect(output).not.toContain('sk-do-not-commit');
  });

  it('allows guard checks for paths outside risky approval rules', async () => {
    const repo = await writeGuardRepo('guard-allowed');

    await runGuard([
      'guard',
      'check',
      '--cwd',
      repo,
      '--path',
      'apps/api/PublicController.php',
      '--action',
      'edit',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const parsed = parseLoggedJson(output);
    expect(parsed).toMatchObject({
      schema_version: 'viewport.cli.guard_check/v1',
      command: 'guard check',
      ok: true,
      path: 'apps/api/PublicController.php',
      action: 'edit',
      risk: 'low',
      decision: 'allowed',
      approval_rules: [],
    });
    expect(parsed['manifest_digest']).toMatch(/^sha256:/);
  });

  it('blocks guard checks for risky paths that require approval', async () => {
    const repo = await writeGuardRepo('guard-blocked');

    await expect(
      runGuard([
        'guard',
        'check',
        '--cwd',
        repo,
        '--path',
        'apps/api/Auth/LoginController.php',
        '--action',
        'edit',
        '--json',
      ]),
    ).rejects.toThrow('Viewport guard requires approval for apps/api/Auth/LoginController.php');

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const parsed = parseLoggedJson(output);
    expect(parsed).toMatchObject({
      schema_version: 'viewport.cli.guard_check/v1',
      command: 'guard check',
      ok: false,
      path: 'apps/api/Auth/LoginController.php',
      action: 'edit',
      risk: 'high',
      decision: 'requires_approval',
      approval_rules: [
        expect.objectContaining({
          id: 'security-review',
          path: 'apps/api/Auth/**',
          require: ['team:security'],
          checks: ['npm run test -- session-rotation'],
          reviewers: ['team:security'],
        }),
      ],
    });
  });

  it('fails guard checks when the repo contract is invalid', async () => {
    const repo = path.join(tempHome, 'guard-invalid');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'approvals:',
        '  risky_paths:',
        '    - path: apps/api/Auth/**',
        '      require: []',
        '',
      ].join('\n'),
    );

    await expect(
      runGuard([
        'guard',
        'check',
        '--cwd',
        repo,
        '--path',
        'apps/api/Auth/LoginController.php',
        '--json',
      ]),
    ).rejects.toThrow('Viewport guard could not validate the repo contract');

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const parsed = parseLoggedJson(output);
    expect(parsed).toMatchObject({
      schema_version: 'viewport.cli.guard_check/v1',
      command: 'guard check',
      ok: false,
      risk: 'unknown',
      decision: 'contract_invalid',
      approval_rules: [],
    });
    expect(parsed['errors']).toEqual([expect.objectContaining({ code: 'invalid_config_skipped' })]);
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

async function runGuard(args: string[]): Promise<void> {
  process.argv = ['node', 'vpd', ...args];
  const { guard } = await import('../../src/cli/guard-command.js');
  await guard();
}

function parseLoggedJson(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
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

async function writeGuardRepo(name: string): Promise<string> {
  const repo = path.join(tempRoot(), name);
  await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.viewport', 'config.yaml'),
    [
      'version: 1',
      'approvals:',
      '  risky_paths:',
      '    - id: security-review',
      '      path: apps/api/Auth/**',
      '      require: [team:security]',
      '      checks:',
      '        - npm run test -- session-rotation',
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
