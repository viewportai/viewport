import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('diagnostic command', () => {
  const originalArgv = process.argv.slice();
  const originalHome = process.env['VIEWPORT_HOME'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-diagnostic-command-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalHome) process.env['VIEWPORT_HOME'] = originalHome;
    else delete process.env['VIEWPORT_HOME'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('prints a sanitized support snapshot without secret material', async () => {
    await fs.writeFile(
      path.join(homeDir, 'config.json'),
      JSON.stringify(
        {
          machineId: 'machine_1',
          daemon: {
            server: {
              url: 'https://api.getviewport.test',
              contextCandidateDecisionKeys: {
                route_a: 'decision-secret',
              },
            },
            relay: {
              issueToken: 'relay-issue-token',
              signingKeys: {
                key_1: 'relay-signing-secret',
              },
            },
            worker: {
              lifecycle: 'persistent',
              transport: 'polling',
              serverUrl: 'https://api.getviewport.test',
              workspaceId: 'workspace_1',
              credential: 'worker-credential-secret',
              workspaceRoot: path.join(homeDir, 'workspace'),
              identityKeyPath: path.join(homeDir, 'worker-identity.json'),
              publicKeyFingerprint: 'a'.repeat(64),
              capabilities: {
                agents: {
                  claude: {
                    id: 'claude',
                    available: true,
                    models: ['claude-sonnet'],
                  },
                },
                secrets: ['github/token'],
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    process.argv = ['node', 'vpd', 'diagnostic', '--json'];
    const { diagnostic } = await import('../../src/cli/diagnostic-command.js');

    await diagnostic();

    const raw = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(raw) as {
      command: string;
      ok: boolean;
      supportPacket: {
        docsUrl: string;
        omittedSecrets: string[];
      };
      runtime: {
        nodeVersion: string;
      };
      paths: {
        viewportHome: string;
        configFile: string;
      };
      config: {
        present: boolean;
        ok: boolean;
        value: {
          machineId: string;
          daemon: {
            server: {
              url: string;
              contextCandidateDecisionKeys: string;
            };
            relay: {
              issueToken: string;
              signingKeys: string;
            };
            worker: {
              serverUrl: string;
              workspaceId: string;
              credential: string;
              workspaceRoot: string;
              identityKeyPath: string;
              publicKeyFingerprint: string;
              capabilities: {
                secrets: string;
              };
            };
          };
        };
      };
    };
    expect(payload.command).toBe('diagnostic');
    expect(payload.ok).toBe(true);
    expect(payload.supportPacket.docsUrl).toBe(
      'https://docs.getviewport.com/troubleshooting/support-packet',
    );
    expect(payload.supportPacket.omittedSecrets).toContain('lease_tokens');
    expect(payload.runtime.nodeVersion).toBe(process.version);
    expect(payload.paths.viewportHome).toBe(homeDir);
    expect(payload.paths.configFile).toBe(path.join(homeDir, 'config.json'));
    expect(payload.config.present).toBe(true);
    expect(payload.config.ok).toBe(true);
    expect(payload.config.value.machineId).toBe('machine_1');
    expect(payload.config.value.daemon.server.url).toBe('https://api.getviewport.test');
    expect(payload.config.value.daemon.worker.workspaceId).toBe('workspace_1');
    expect(payload.config.value.daemon.worker.workspaceRoot).toBe(path.join(homeDir, 'workspace'));
    expect(payload.config.value.daemon.worker.identityKeyPath).toBe(
      path.join(homeDir, 'worker-identity.json'),
    );
    expect(payload.config.value.daemon.worker.publicKeyFingerprint).toBe('a'.repeat(64));
    expect(payload.config.value.daemon.worker.credential).toBe('[redacted]');
    expect(payload.config.value.daemon.relay.issueToken).toBe('[redacted]');
    expect(payload.config.value.daemon.relay.signingKeys).toBe('[redacted]');
    expect(payload.config.value.daemon.server.contextCandidateDecisionKeys).toBe('[redacted]');
    expect(payload.config.value.daemon.worker.capabilities.secrets).toBe('[redacted]');
    expect(raw).not.toContain('worker-credential-secret');
    expect(raw).not.toContain('relay-issue-token');
    expect(raw).not.toContain('relay-signing-secret');
    expect(raw).not.toContain('decision-secret');
    expect(raw).not.toContain('github/token');
  });

  it('reports invalid config without hiding runtime diagnostics', async () => {
    await fs.writeFile(path.join(homeDir, 'config.json'), '{not-valid-json', 'utf8');
    process.argv = ['node', 'vpd', 'diagnostic', '--json'];
    const { diagnostic } = await import('../../src/cli/diagnostic-command.js');

    await diagnostic();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      config: {
        present: boolean;
        ok: boolean;
        value: null;
        error: string;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.config.present).toBe(true);
    expect(payload.config.ok).toBe(false);
    expect(payload.config.value).toBe(null);
    expect(payload.config.error).toContain('Invalid viewport config JSON');
  });
});
