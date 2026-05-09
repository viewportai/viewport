import fs from 'node:fs/promises';
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
        workspaceId: 'context-alpha',
        issueToken: 'runtime-token',
        tlsVerify: 'auto',
      },
    });

    let pushedEvents: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/push')) {
        pushedEvents = body.events;
        expect(String(url)).toBe(
          'https://app.getviewport.test/api/runtime/workspaces/context-alpha/context-vault/events/push',
        );
        expect(JSON.stringify(pushedEvents)).toContain('viewport.context_event/v1');
        expect(JSON.stringify(pushedEvents)).not.toContain(
          'Context sync must never send plaintext.',
        );
        return jsonResponse({ ok: true, accepted: pushedEvents.length, events: [] }, 202);
      }

      expect(String(url)).toBe(
        'https://app.getviewport.test/api/runtime/workspaces/context-alpha/context-vault/events/pull',
      );
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

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
});
