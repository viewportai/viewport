import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('context CLI command', () => {
  const originalArgv = process.argv.slice();
  const originalFetch = globalThis.fetch;
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempHome: string;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-cli-'));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('initializes, adds, and resolves local context through vpd arguments', async () => {
    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--user',
      'alice',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--key-store',
      'file',
      '--json',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "context init"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"keyStore": "file"'));
    logSpy.mockClear();

    await runContext([
      'context',
      'add',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
      '--key-store',
      'file',
      '--json',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "context add"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"scope": "resource"'));
    logSpy.mockClear();

    const { writeContextProfile } = await import('../../src/context/local-edge-store.js');
    const profile = await writeContextProfile({
      contextResourceId: 'context-alpha',
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
      '--context',
      'context-alpha',
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

  it('lists and creates platform Context Vault metadata through the paired runtime credential', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: false,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'http://app.getviewport.test',
        workspaceId: 'workspace-alpha',
        issueToken: 'runtime-token',
        tlsVerify: 'auto',
      },
    });

    const requests: Array<{ url: string; body?: unknown; method?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: requestUrl, method: init?.method, body });
      if (requestUrl.includes('/context-vaults?')) {
        expect(requestUrl).toBe(
          'http://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vaults?credential=runtime-token',
        );
        return jsonResponse({
          data: [
            {
              id: '01vault',
              vault_id: 'ctx_platform_arch',
              name: 'Platform Architecture',
              workspace_id: 'workspace-alpha',
              description: null,
              encryption: { privacy: 'control_plane_blind', server_plaintext: false },
              access: { role: 'owner', can_view: true },
            },
          ],
        });
      }
      expect(requestUrl).toBe(
        'http://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vaults',
      );
      expect(body).toMatchObject({
        credential: 'runtime-token',
        name: 'Runtime Guardrails',
        vault_id: 'ctx_runtime_guardrails',
      });
      return jsonResponse(
        {
          data: {
            id: '01created',
            vault_id: 'ctx_runtime_guardrails',
            name: 'Runtime Guardrails',
            workspace_id: 'workspace-alpha',
            description: null,
            encryption: { privacy: 'control_plane_blind', server_plaintext: false },
            access: { role: 'owner', can_view: true },
          },
        },
        201,
      );
    }) as typeof fetch;

    await runContext(['context', 'vaults', '--json']);
    await runContext([
      'context',
      'create',
      '--name',
      'Runtime Guardrails',
      '--vault',
      'ctx_runtime_guardrails',
      '--json',
    ]);

    expect(requests).toHaveLength(2);
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context vaults"');
    expect(output).toContain('"vault_id": "ctx_platform_arch"');
    expect(output).toContain('"command": "context create"');
    expect(output).toContain('"vault_id": "ctx_runtime_guardrails"');
    expect(output).not.toContain('runtime-token');
  });

  it('lists device enrollment status through the paired runtime credential', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: false,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'http://app.getviewport.test',
        workspaceId: 'workspace-alpha',
        issueToken: 'runtime-token',
        tlsVerify: 'auto',
      },
    });

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://app.getviewport.test/api/runtime/workspaces/workspace-alpha/crypto/device-enrollments?credential=runtime-token',
      );
      expect(init?.method).toBe('GET');
      return jsonResponse({
        data: [
          {
            id: 'enroll-vps-1',
            workspace_id: 'workspace-alpha',
            user_id: 42,
            device_id: 'bob-vps',
            device_label: 'Bob VPS',
            encryption_public_key_jwk: { kty: 'OKP', crv: 'X25519', x: 'public-x' },
            signing_public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-sign' },
            fingerprint: 'sha256:vps-fingerprint',
            nonce: 'nonce-1',
            status: 'approved',
            grants: [],
          },
        ],
      });
    }) as typeof fetch;

    await runContext(['context', 'device-enrollments', '--json']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context device-enrollments"');
    expect(output).toContain('"device_id": "bob-vps"');
    expect(output).toContain('"status": "approved"');
    expect(output).not.toContain('runtime-token');
  });

  it('creates, initializes, and attaches a Context Vault in one command', async () => {
    const repo = path.join(tempHome, 'created-use-repo');
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: false,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'http://app.getviewport.test',
        workspaceId: 'workspace-alpha',
        issueToken: 'runtime-token',
        tlsVerify: 'auto',
      },
    });

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vaults',
      );
      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body).toMatchObject({
        credential: 'runtime-token',
        name: 'Platform Architecture',
        vault_id: 'ctx_platform_arch',
      });
      return jsonResponse(
        {
          data: {
            id: '01created',
            vault_id: 'ctx_platform_arch',
            name: 'Platform Architecture',
            workspace_id: 'workspace-alpha',
            description: null,
            encryption: { privacy: 'control_plane_blind', server_plaintext: false },
            access: { role: 'owner', can_view: true },
          },
        },
        201,
      );
    }) as typeof fetch;

    await runContext([
      'context',
      'create',
      '--name',
      'Platform Architecture',
      '--vault',
      'ctx_platform_arch',
      '--init',
      '--user',
      'alice',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--key-store',
      'file',
      '--use',
      '--path',
      repo,
      '--provider',
      'platform-arch',
      '--json',
    ]);

    const config = await fs.readFile(path.join(repo, '.viewport', 'config.yaml'), 'utf8');
    expect(config).toContain('id: platform-arch');
    expect(config).toContain('provider: viewport-vault');
    expect(config).toContain('vault: ctx_platform_arch');

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context create"');
    expect(output).toContain('"local_context"');
    expect(output).toContain('"contextResourceId": "ctx_platform_arch"');
    expect(output).toContain('"config"');
    expect(output).toContain('"manifest_digest"');
  });

  it('installs a repo-local Claude rule for configured Viewport context', async () => {
    const repo = path.join(tempHome, 'rules-repo');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      ['version: 1', 'resources:', '  contexts:', '    - ctx-team', ''].join('\n'),
      'utf8',
    );

    await runContext(['context', 'rules', 'install', '--path', repo, '--json']);

    const rulePath = path.join(repo, '.claude', 'rules', 'viewport-context.md');
    const rule = await fs.readFile(rulePath, 'utf8');
    expect(rule).toContain('viewport-generated-context-rule');
    expect(rule).toContain('vpd context search --path . --query');
    expect(rule).toContain('vpd context propose --path .');

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context rules install"');
    expect(output).toContain('"installed": true');
  });

  it('attaches a platform Context Vault provider to repo config', async () => {
    const repo = path.join(tempHome, 'use-repo');

    await runContext([
      'context',
      'use',
      'ctx_platform_arch',
      '--path',
      repo,
      '--provider',
      'platform-arch',
      '--json',
    ]);

    const config = await fs.readFile(path.join(repo, '.viewport', 'config.yaml'), 'utf8');
    expect(config).toContain('version: 1');
    expect(config).toContain('id: platform-arch');
    expect(config).toContain('provider: viewport-vault');
    expect(config).toContain('vault: ctx_platform_arch');

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context use"');
    expect(output).toContain('"changed": true');
    expect(output).toContain('"provider": "viewport-vault"');
    expect(output).toContain('"vault": "ctx_platform_arch"');
  });

  it('keeps context use idempotent for an existing vault provider', async () => {
    const repo = path.join(tempHome, 'use-existing-repo');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: ctx_platform_arch',
        '      provider: viewport-vault',
        '      vault: ctx_platform_arch',
        '      required: true',
        '',
      ].join('\n'),
    );

    await runContext(['context', 'use', 'ctx_platform_arch', '--path', repo, '--json']);

    const config = await fs.readFile(path.join(repo, '.viewport', 'config.yaml'), 'utf8');
    expect(config.match(/viewport-vault/g)).toHaveLength(1);
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"changed": false');
  });

  it('proposes candidate context through vpd arguments without resolving it before review', async () => {
    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--title',
      'Candidate testing policy',
      '--body',
      'Candidate-only notes must wait for Inbox review.',
      '--source-kind',
      'workflow',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    await runContext([
      'context',
      'resolve',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--query',
      'Inbox review',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context propose"');
    expect(output).toContain('"trustState": "candidate"');
    expect(output).not.toContain('Candidate-only notes must wait for Inbox review.');
  });

  it('previews a candidate locally without promoting it into approved context', async () => {
    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--title',
      'Incident file warning',
      '--body',
      'Files under apps/api/Auth caused an incident last week; run session rotation tests.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    const proposeOutput = parseLastJsonLog() as { candidate: { id: string; bodyDigest: string } };
    logSpy.mockClear();

    await runContext([
      'context',
      'candidate-preview',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--event',
      proposeOutput.candidate.id,
      '--json',
    ]);

    const previewOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(previewOutput).toContain('"command": "context candidate-preview"');
    expect(previewOutput).toContain('"title": "Incident file warning"');
    expect(previewOutput).toContain(
      'Files under apps/api/Auth caused an incident last week; run session rotation tests.',
    );

    logSpy.mockClear();
    await runContext([
      'context',
      'resolve',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--query',
      'incident',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    const resolveOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(resolveOutput).not.toContain('Files under apps/api/Auth caused an incident');
  });

  it('lists recent context candidate decision applications from the trusted edge journal', async () => {
    const { recordCandidateDecisionApplication } =
      await import('../../src/context/local-edge-decision-applications.js');
    await recordCandidateDecisionApplication({
      home: tempHome,
      contextResourceId: 'context-alpha',
      application: {
        schema_version: 'viewport.context_candidate_application/v1',
        decision_id: 'ctxd_inbox_1',
        inbox_item_id: 'inbox_1',
        repo_id: 'context-alpha',
        candidate_event_id: 'ctxc_event_1',
        payload_digest: 'sha256:test',
        decision: 'approved',
        status: 'applied',
        actor_name: 'alice-laptop',
        candidate_id: 'ctxc_1',
        emitted: 2,
        applied_at: new Date().toISOString(),
        platform_signature_digest: 'sha256:decision',
      },
    });

    await runContext([
      'context',
      'decisions',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--since',
      '24h',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context decisions"');
    expect(output).toContain('"decision_id": "ctxd_inbox_1"');
    expect(output).toContain('"status": "applied"');
  });

  it('searches repo-docs providers through the resolved contract', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-repo-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo-docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(repo, 'docs', 'auth.md'),
      'Auth changes must run session rotation tests.',
    );

    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repo,
      '--query',
      'session rotation',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_search/v1"');
    expect(output).toContain('"provider_id": "repo-docs"');
    expect(output).toContain('"privacy": "local_only"');
    expect(output).toContain('Auth changes must run session rotation tests.');
    expect(output).toContain('"manifest_digest"');
  });

  it('reports provider adapters that are declared but not implemented yet', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-adapter-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: research_notebook',
        '      provider: notebooklm',
        '      notebook: nb_platform',
        '      credential_ref: credentials/notebooklm/platform',
      ].join('\n'),
    );

    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repo,
      '--query',
      'session rotation',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_search/v1"');
    expect(output).toContain('"id": "research_notebook"');
    expect(output).toContain('"provider": "notebooklm"');
    expect(output).toContain('"status": "skipped"');
    expect(output).toContain('"reason": "adapter_not_implemented"');
    expect(output).not.toContain('credentials/notebooklm/platform');
  });

  it('gets one repo-docs entry by provider-scoped id', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-get-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
      ].join('\n'),
    );
    await fs.writeFile(path.join(repo, 'docs', 'deploy.md'), 'Deploys require a rollback note.');

    await runContext([
      'context',
      'get',
      'docs:docs/deploy.md',
      '--home',
      tempHome,
      '--path',
      repo,
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_get/v1"');
    expect(output).toContain('"id": "docs:docs/deploy.md"');
    expect(output).toContain('Deploys require a rollback note.');
  });

  it('proposes context through a viewport-vault provider declared in the contract', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-propose-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: guardrails',
        '      provider: viewport-vault',
        '      vault: context-alpha',
      ].join('\n'),
    );

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'guardrails',
      '--device',
      'alice-laptop',
      '--title',
      'Auth testing rule',
      '--body',
      'Auth changes must run session rotation tests.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_propose/v1"');
    expect(output).toContain('"provider_id": "guardrails"');
    expect(output).toContain('"status": "pending_review"');
    expect(output).toContain('"payload_digest"');
    expect(output).not.toContain('Auth changes must run session rotation tests.');
  });

  it('adds approved context through a viewport-vault provider declared in the contract', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-add-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: team_memory',
        '      provider: viewport-vault',
        '      vault: context-alpha',
      ].join('\n'),
    );

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'add',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'team_memory',
      '--device',
      'alice-laptop',
      '--title',
      'Auth testing rule',
      '--body',
      'Auth changes must run session rotation tests.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_add/v1"');
    expect(output).toContain('"command": "context add"');
    expect(output).toContain('"provider_id": "team_memory"');
    expect(output).toContain('"manifest_digest"');
    expect(output).toContain('"entry"');
    expect(output).not.toContain('Auth changes must run session rotation tests.');

    logSpy.mockClear();
    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'team_memory',
      '--device',
      'alice-laptop',
      '--query',
      'rotation',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const searchOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(searchOutput).toContain('"provider_id": "team_memory"');
    expect(searchOutput).toContain('Auth changes must run session rotation tests.');
  });

  it('reuses one local viewport-vault cache across multiple repo contracts', async () => {
    const repoA = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-shared-vault-a-'));
    const repoB = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-shared-vault-b-'));
    for (const [repo, providerId] of [
      [repoA, 'team_memory'],
      [repoB, 'service_memory'],
    ] as const) {
      await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
      await fs.writeFile(
        path.join(repo, '.viewport', 'config.yaml'),
        [
          'version: 1',
          'context:',
          '  providers:',
          `    - id: ${providerId}`,
          '      provider: viewport-vault',
          '      vault: context-alpha',
          '      required: true',
        ].join('\n'),
      );
    }

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'add',
      '--home',
      tempHome,
      '--path',
      repoA,
      '--provider',
      'team_memory',
      '--device',
      'alice-laptop',
      '--title',
      'Shared vault rule',
      '--body',
      'Any repo using this vault should see the same approved context.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const reposDir = path.join(tempHome, 'repos');
    const repoStateDirs = (await fs.readdir(reposDir)).filter((name) => !name.startsWith('.'));
    expect(repoStateDirs).toEqual(['context-alpha']);
    await fs.access(path.join(tempHome, 'repos', 'context-alpha', 'events'));
    await fs.access(path.join(tempHome, 'context', 'canonical-resources', 'context-alpha.json'));

    logSpy.mockClear();
    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repoB,
      '--provider',
      'service_memory',
      '--device',
      'alice-laptop',
      '--query',
      'approved context',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const searchOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(searchOutput).toContain('"provider_id": "service_memory"');
    expect(searchOutput).toContain(
      'Any repo using this vault should see the same approved context.',
    );
  });

  it('routes unsupported provider proposals into the configured viewport-vault fallback', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-fallback-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '    - id: team_memory',
        '      provider: viewport-vault',
        '      vault: context-alpha',
        '  resolution:',
        '    propose_fallback_provider: team_memory',
      ].join('\n'),
    );
    await fs.writeFile(path.join(repo, 'docs', 'auth.md'), 'Auth docs are local only.');

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'repo_docs',
      '--device',
      'alice-laptop',
      '--title',
      'Auth testing rule',
      '--body',
      'Auth changes must run session rotation tests.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_propose/v1"');
    expect(output).toContain('"requested_provider_id": "repo_docs"');
    expect(output).toContain('"provider_id": "team_memory"');
    expect(output).toContain('"fallback_provider_id": "team_memory"');
    expect(output).toContain('"fallback_reason": "provider_does_not_support_propose"');
    expect(output).toContain('"status": "pending_review"');
    expect(output).toContain('"payload_digest"');
    expect(output).not.toContain('Auth changes must run session rotation tests.');
  });

  it('routes context proposals to the single proposal-capable provider from the repo contract', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-default-propose-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '    - id: team_memory',
        '      provider: viewport-vault',
        '      vault: context-alpha',
      ].join('\n'),
    );

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--path',
      repo,
      '--device',
      'alice-laptop',
      '--title',
      'Incident-sensitive file rule',
      '--body',
      'Files under billing/reconciliation caused an incident last week; inspect rollback paths before editing.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_propose/v1"');
    expect(output).toContain('"provider_id": "team_memory"');
    expect(output).toContain('"status": "pending_review"');
    expect(output).toContain('"payload_digest"');
    expect(output).not.toContain('Files under billing/reconciliation caused an incident');
  });

  it('closes the candidate review loop through provider CLI, sync, signed decision, and receipt push', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-candidate-loop-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: guardrails',
        '      provider: viewport-vault',
        '      vault: context-alpha',
        '      required: true',
      ].join('\n'),
    );

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--user',
      'alice',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--key-store',
      'file',
      '--json',
    ]);
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'guardrails',
      '--device',
      'alice-laptop',
      '--title',
      'Auth rotation candidate',
      '--body',
      'Agent runs touching auth must include session rotation proof.',
      '--source-kind',
      'workflow',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    const proposeOutput = parseLastJsonLog() as {
      candidate_id: string;
      payload_digest: string;
      status: string;
    };
    expect(proposeOutput.status).toBe('pending_review');
    expect(proposeOutput.payload_digest).toMatch(/^sha256:/);

    const platformEvents: unknown[] = [];
    let pushedBodies: string[] = [];
    const decisionState: { current?: ReturnType<typeof signedDecision> } = {};
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (requestUrl.endsWith('/push')) {
        pushedBodies.push(String(init?.body ?? ''));
        platformEvents.push(...((body.events as unknown[] | undefined) ?? []));
        expect(JSON.stringify(body)).not.toContain(
          'Agent runs touching auth must include session rotation proof.',
        );
        return jsonResponse(
          { ok: true, accepted: ((body.events as unknown[] | undefined) ?? []).length },
          202,
        );
      }

      expect(requestUrl).toBe(
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/events/pull',
      );
      return jsonResponse({
        data: platformEvents.map((event, index) => ({
          id: index + 1,
          received_at: `2026-05-09T18:00:${String(index).padStart(2, '0')}.000Z`,
          signed_event: event,
        })),
        candidate_decisions: decisionState.current ? [decisionState.current] : [],
      });
    }) as typeof fetch;

    await writeRelayConfig(tempHome);
    await runContext([
      'context',
      'sync-push',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--json',
    ]);
    expect(JSON.stringify(platformEvents)).toContain('entry.proposed');
    expect(JSON.stringify(platformEvents)).not.toContain(
      'Agent runs touching auth must include session rotation proof.',
    );

    const decision = signedDecision({
      schema_version: 'viewport.context_candidate_decision/v1',
      id: 'ctxd_cli_loop_1',
      inbox_item_id: 'inbox_cli_loop_1',
      repo_id: 'context-alpha',
      context_resource_id: 'context-alpha',
      candidate_event_id: proposeOutput.candidate_id,
      payload_digest: proposeOutput.payload_digest,
      decision: 'approved',
      message: 'Approved in Viewport Inbox.',
      decided_at: '2026-05-09T18:01:00.000Z',
      decided_by_user_id: 'user_42',
    });
    decisionState.current = decision;
    await writeRelayConfig(tempHome, {
      [decision.platform_signature.kid]: decision.platform_signature.public_key,
    });

    await runContext([
      'context',
      'sync-pull',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    const pullOutput = parseLastJsonLog() as { appliedCandidateDecisions: number };
    expect(pullOutput.appliedCandidateDecisions).toBe(1);

    logSpy.mockClear();
    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'guardrails',
      '--device',
      'alice-laptop',
      '--query',
      'session rotation',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    const searchOutput = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(searchOutput).toContain('"schema_version": "viewport.cli.context_search/v1"');
    expect(searchOutput).toContain('"provider_id": "guardrails"');
    expect(searchOutput).toContain('Agent runs touching auth must include session rotation proof.');

    pushedBodies = [];
    await runContext([
      'context',
      'sync-push',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--json',
    ]);
    const receiptPush = pushedBodies.join('\n');
    expect(receiptPush).toContain('candidate_decision_applications');
    expect(receiptPush).toContain('ctxd_cli_loop_1');
    expect(receiptPush).toContain('candidate.approved');
    expect(receiptPush).toContain('entry.approved');
    expect(receiptPush).not.toContain(
      'Agent runs touching auth must include session rotation proof.',
    );
  });

  it('searches approved viewport-vault context through the resolved provider contract', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-vault-search-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: guardrails',
        '      provider: viewport-vault',
        '      vault: context-alpha',
      ].join('\n'),
    );

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    await runContext([
      'context',
      'add',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--title',
      'Auth testing rule',
      '--body',
      'Auth changes must run session rotation tests.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);
    logSpy.mockClear();

    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'guardrails',
      '--device',
      'alice-laptop',
      '--query',
      'rotation',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"schema_version": "viewport.cli.context_search/v1"');
    expect(output).toContain('"provider_id": "guardrails"');
    expect(output).toContain('"privacy": "control_plane_blind"');
    expect(output).toContain('Auth changes must run session rotation tests.');
  });

  it('bounds viewport-vault provider search by the resolved context size budget', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-provider-vault-budget-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: guardrails',
        '      provider: viewport-vault',
        '      vault: context-alpha',
        '  resolution:',
        '    size_budget: 2kb',
      ].join('\n'),
    );

    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    for (let index = 0; index < 5; index += 1) {
      await runContext([
        'context',
        'add',
        '--home',
        tempHome,
        '--context',
        'context-alpha',
        '--device',
        'alice-laptop',
        '--title',
        `Auth testing rule ${index}`,
        '--body',
        `Auth changes must run session rotation tests. Budget proof ${index}.`,
        '--passphrase',
        'alice-passphrase',
        '--recovery-code',
        'alice-recovery',
        '--json',
      ]);
    }
    logSpy.mockClear();

    await runContext([
      'context',
      'search',
      '--home',
      tempHome,
      '--path',
      repo,
      '--provider',
      'guardrails',
      '--device',
      'alice-laptop',
      '--query',
      'rotation',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = parseLastJsonLog() as {
      results: unknown[];
      providers_consulted: Array<{ result_count: number }>;
    };
    expect(output.results).toHaveLength(1);
    expect(output.providers_consulted[0]?.result_count).toBe(1);
  });

  it('pushes and pulls canonical encrypted context events using saved relay config', async () => {
    await runContext([
      'context',
      'init',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
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
    await runContext([
      'context',
      'add',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--title',
      'Sync policy',
      '--body',
      'Context sync must never send plaintext.',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      server: {
        url: 'https://app.getviewport.test',
      },
      relay: {
        enabled: true,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'https://app.getviewport.test',
        workspaceId: 'workspace-alpha',
        issueToken: 'runtime-token',
        tlsVerify: '1',
      },
    });

    let pushedEvents: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/push')) {
        pushedEvents = body.events;
        expect(String(url)).toBe(
          'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/events/push',
        );
        expect(JSON.stringify(pushedEvents)).toContain('viewport.context_event/v1');
        expect(JSON.stringify(pushedEvents)).not.toContain(
          'Context sync must never send plaintext.',
        );
        return jsonResponse({ ok: true, accepted: pushedEvents.length, events: [] }, 202);
      }

      expect(String(url)).toBe(
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/events/pull',
      );
      expect(body).toMatchObject({ context_resource_id: 'context-alpha' });
      return jsonResponse({
        data: pushedEvents.map((event, index) => ({ id: index + 1, signed_event: event })),
      });
    }) as typeof fetch;

    logSpy.mockClear();
    await runContext([
      'context',
      'sync-push',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--json',
    ]);

    await runContext([
      'context',
      'sync-pull',
      '--home',
      tempHome,
      '--context',
      'context-alpha',
      '--device',
      'alice-laptop',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context sync-push"');
    expect(output).toContain('"accepted"');
    expect(output).toContain('"command": "context sync-pull"');
    expect(output).toContain('"pulled"');
  });

  it('syncs every visible context vault for an approved user device in one command', async () => {
    await runContext([
      'context',
      'user-init',
      '--home',
      tempHome,
      '--user',
      'alice',
      '--device',
      'alice-vps',
      '--passphrase',
      'alice-passphrase',
      '--recovery-code',
      'alice-recovery',
      '--key-store',
      'file',
      '--json',
    ]);

    const pulledContexts: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/context-vaults?credential=runtime-token')) {
        return jsonResponse({
          data: [
            { vault_id: 'context-alpha', access: { can_view: true } },
            { vault_id: 'context-beta', access: { can_view: true } },
            { vault_id: 'context-hidden', access: { can_view: false } },
          ],
        });
      }

      if (requestUrl.includes('/crypto/rotation-requests')) {
        return jsonResponse({ data: [] });
      }

      if (requestUrl.includes('/team-epoch-member-grants')) {
        return jsonResponse({ data: [] });
      }

      if (requestUrl.endsWith('/grants/revocations/pending')) {
        return jsonResponse({ revocations: [] });
      }

      if (requestUrl.endsWith('/grants/pending')) {
        return jsonResponse({ grants: [] });
      }

      if (requestUrl.endsWith('/events/pull')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        pulledContexts.push(String(body.context_resource_id));
        return jsonResponse({ data: [], candidate_decisions: [] });
      }

      throw new Error(`Unexpected sync-all URL ${requestUrl}`);
    }) as typeof fetch;

    logSpy.mockClear();
    await runContext([
      'context',
      'sync-all',
      '--home',
      tempHome,
      '--user',
      'alice',
      '--device',
      'alice-vps',
      '--workspace',
      'workspace-alpha',
      '--server-url',
      'http://app.getviewport.test',
      '--credential',
      'runtime-token',
      '--json',
    ]);

    expect(pulledContexts).toEqual(['context-alpha', 'context-beta']);
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('"command": "context sync-all"');
    expect(output).toContain('"vaults": 2');
  });

  it('does not treat saved remote workspace id as an implicit context resource id', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'https://app.getviewport.test',
        workspaceId: 'workspace-not-context',
        issueToken: 'runtime-token',
        tlsVerify: 'auto',
      },
    });

    await expect(
      runContext(['context', 'sync-push', '--home', tempHome, '--json']),
    ).rejects.toThrow('requires --context <resource-id>');
  });

  async function runContext(args: string[]): Promise<void> {
    process.argv = ['node', 'vpd', ...args];
    vi.resetModules();
    const { context } = await import('../../src/cli/context-command.js');
    await context();
  }

  async function writeRelayConfig(
    home: string,
    contextCandidateDecisionKeys?: Record<string, string>,
  ): Promise<void> {
    const previous = process.env['VIEWPORT_HOME'];
    process.env['VIEWPORT_HOME'] = home;
    vi.resetModules();
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      server: {
        url: 'https://app.getviewport.test',
        tlsVerify: '1',
        ...(contextCandidateDecisionKeys ? { contextCandidateDecisionKeys } : {}),
      },
      relay: {
        enabled: true,
        endpoint: 'wss://getviewport.test:7781/ws',
        serverUrl: 'https://app.getviewport.test',
        workspaceId: 'workspace-alpha',
        issueToken: 'runtime-token',
        tlsVerify: '1',
      },
    });
    if (previous === undefined) {
      delete process.env['VIEWPORT_HOME'];
    } else {
      process.env['VIEWPORT_HOME'] = previous;
    }
  }

  function parseLastJsonLog(): unknown {
    const line = logSpy.mock.calls.at(-1)?.join(' ');
    if (!line) throw new Error('Expected a JSON log line');
    return JSON.parse(line);
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function signedDecision<T extends Record<string, unknown>>(
    record: T,
  ): T & {
    platform_signature: {
      algorithm: 'Ed25519';
      kid: string;
      public_key: string;
      signature: string;
      signed_payload_digest: string;
    };
  } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const rawPublicKey = publicDer.subarray(-32);
    const payload = canonicalJson({
      schema_version: record.schema_version,
      id: record.id,
      inbox_item_id: record.inbox_item_id ?? null,
      repo_id: record.repo_id,
      context_resource_id: record.context_resource_id ?? record.repo_id,
      candidate_event_id: record.candidate_event_id,
      payload_digest: record.payload_digest ?? null,
      decision: record.decision,
      message: record.message ?? null,
      decided_at: record.decided_at ?? null,
      decided_by_user_id: record.decided_by_user_id ?? null,
    });
    return {
      ...record,
      platform_signature: {
        algorithm: 'Ed25519',
        kid: 'platform-v1',
        public_key: rawPublicKey.toString('base64'),
        signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'),
        signed_payload_digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
      },
    };
  }

  function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
  }

  function sortKeys(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
});
