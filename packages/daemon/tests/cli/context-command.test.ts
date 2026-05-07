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
      '--key-store',
      'file',
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

  it('proposes candidate context through vpd arguments without resolving it before review', async () => {
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
    logSpy.mockClear();

    await runContext([
      'context',
      'propose',
      '--home',
      tempHome,
      '--project',
      'project-alpha',
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
      '--project',
      'project-alpha',
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

  it('pushes and pulls canonical encrypted context events using saved relay config', async () => {
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
        workspaceId: 'project-alpha',
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
          'https://app.getviewport.test/api/runtime/workspaces/project-alpha/context-vault/events/push',
        );
        expect(JSON.stringify(pushedEvents)).toContain('viewport.context_event/v1');
        expect(JSON.stringify(pushedEvents)).not.toContain(
          'Context sync must never send plaintext.',
        );
        return jsonResponse({ ok: true, accepted: pushedEvents.length, events: [] }, 202);
      }

      expect(String(url)).toBe(
        'https://app.getviewport.test/api/runtime/workspaces/project-alpha/context-vault/events/pull',
      );
      return jsonResponse({
        data: pushedEvents.map((event, index) => ({ id: index + 1, signed_event: event })),
      });
    }) as typeof fetch;

    logSpy.mockClear();
    await runContext(['context', 'sync-push', '--home', tempHome, '--json']);

    await runContext([
      'context',
      'sync-pull',
      '--home',
      tempHome,
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
