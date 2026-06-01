import { describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { FakeSandboxProvider } from '../src/fake-provider.js';
import { ManagedRunnerService } from '../src/runner-service.js';

describe('ManagedRunnerService', () => {
  it('runs install and worker commands with ephemeral secrets redacted from records', async () => {
    const provider = new FakeSandboxProvider();
    const service = new ManagedRunnerService(provider);

    const record = await service.start({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      serverUrl: 'https://api.getviewport.test',
      leaseToken: 'lease-secret',
      vpdInstallCommand: 'npm install -g @viewportai/daemon',
      workerCommand: 'echo "$VIEWPORT_RUN_LEASE_TOKEN" && echo "$GITHUB_TOKEN"',
      secrets: [{ name: 'GITHUB_TOKEN', value: 'ghs_ephemeral_secret' }],
    });

    expect(record.status).toBe('completed');
    expect(record.provider).toBe('fake');
    expect(record.command).not.toContain('ghs_ephemeral_secret');
    expect(JSON.stringify(record)).not.toContain('ghs_ephemeral_secret');
    expect(JSON.stringify(record)).not.toContain('lease-secret');

    const sandbox = provider.sandboxes[0];
    expect(sandbox.commands.map((command) => command.command)).toEqual([
      'npm install -g @viewportai/daemon',
      'echo "$VIEWPORT_RUN_LEASE_TOKEN" && echo "$GITHUB_TOKEN"',
    ]);
    expect(sandbox.commands[1].env).toMatchObject({
      VIEWPORT_SERVER_URL: 'https://api.getviewport.test',
      VIEWPORT_RUN_LEASE_TOKEN: 'lease-secret',
      GITHUB_TOKEN: 'ghs_ephemeral_secret',
    });
    expect(sandbox.killed).toBe(true);
  });

  it('writes sandbox bootstrap before running vpd run-once', async () => {
    const provider = new FakeSandboxProvider();
    const service = new ManagedRunnerService(provider);

    const record = await service.start({
      runId: 'run-bootstrap',
      workspaceId: 'workspace-bootstrap',
      serverUrl: 'https://api.getviewport.test',
      leaseToken: 'lease-secret',
      vpdInstallCommand: 'true',
      bootstrapPath: '/viewport/bootstrap/bootstrap.json',
      bootstrap: {
        schema: 'viewport.sandbox_bootstrap/v1',
        credential: 'vpexec_secret',
        lease: {
          lease_token: 'lease-secret',
        },
      },
    });

    expect(record.status).toBe('completed');
    expect(JSON.stringify(record)).not.toContain('vpexec_secret');
    expect(JSON.stringify(record)).not.toContain('lease-secret');

    const sandbox = provider.sandboxes[0];
    expect(sandbox.files.get('/viewport/bootstrap/bootstrap.json')).toContain('viewport.sandbox_bootstrap/v1');
    expect(sandbox.commands.map((command) => command.command)).toEqual([
      'true',
      'vpd worker run-once --bootstrap /viewport/bootstrap/bootstrap.json --json',
    ]);
  });

  it('uploads a local vpd package override before install when configured', async () => {
    const provider = new FakeSandboxProvider();
    const service = new ManagedRunnerService(provider);
    const tarballPath = '/tmp/viewport-managed-runner-test-vpd.tgz';
    const previous = process.env.VPD_PACKAGE_TARBALL;
    process.env.VPD_PACKAGE_TARBALL = tarballPath;
    await writeFile(tarballPath, 'local-vpd-tarball');

    try {
      const record = await service.start({
        runId: 'run-package-override',
        workspaceId: 'workspace-package-override',
        serverUrl: 'https://api.getviewport.test',
        leaseToken: 'lease-secret',
        vpdInstallCommand: 'base64 -d /tmp/viewport/vpd.tgz.b64 > /tmp/viewport/vpd.tgz && npm install -g /tmp/viewport/vpd.tgz',
        workerCommand: 'vpd worker run-once --lease "$VIEWPORT_RUN_LEASE_TOKEN"',
      });

      expect(record.status).toBe('completed');
      const sandbox = provider.sandboxes[0];
      expect(sandbox.files.get('/tmp/viewport/vpd.tgz.b64')).toBe(Buffer.from('local-vpd-tarball').toString('base64'));
      expect(sandbox.commands[0].command).toContain('/tmp/viewport/vpd.tgz');
    } finally {
      if (previous === undefined) {
        delete process.env.VPD_PACKAGE_TARBALL;
      } else {
        process.env.VPD_PACKAGE_TARBALL = previous;
      }
      await rm(tarballPath, { force: true });
    }
  });

  it('mounts codex auth into the ephemeral sandbox when configured', async () => {
    const provider = new FakeSandboxProvider();
    const service = new ManagedRunnerService(provider);
    const authPath = '/tmp/viewport-managed-runner-codex-auth.json';
    const previous = process.env.CODEX_AUTH_JSON_PATH;
    process.env.CODEX_AUTH_JSON_PATH = authPath;
    await writeFile(authPath, '{"auth_mode":"chatgpt"}');

    try {
      const record = await service.start({
        runId: 'run-codex-auth',
        workspaceId: 'workspace-codex-auth',
        serverUrl: 'https://api.getviewport.test',
        leaseToken: 'lease-secret',
        vpdInstallCommand: 'true',
        workerCommand: 'test -f "$CODEX_HOME/auth.json"',
      });

      expect(record.status).toBe('completed');
      const sandbox = provider.sandboxes[0];
      expect(sandbox.files.get('/home/user/.codex/auth.json')).toBe('{"auth_mode":"chatgpt"}');
      expect(sandbox.commands.map((command) => command.command)).toContain(
        'mkdir -p /home/user/.codex && chmod 700 /home/user/.codex',
      );
      expect(sandbox.commands.at(-1)?.env).toMatchObject({
        CODEX_HOME: '/home/user/.codex',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_AUTH_JSON_PATH;
      } else {
        process.env.CODEX_AUTH_JSON_PATH = previous;
      }
      await rm(authPath, { force: true });
    }
  });

  it('does not inherit the local GitHub proof opt-in from the host environment', async () => {
    const provider = new FakeSandboxProvider();
    const service = new ManagedRunnerService(provider);
    const previous = process.env.VIEWPORT_ALLOW_LOCAL_GITHUB_TOKEN_FOR_PROOF;
    process.env.VIEWPORT_ALLOW_LOCAL_GITHUB_TOKEN_FOR_PROOF = '1';

    try {
      const record = await service.start({
        runId: 'run-local-github-proof-denied',
        workspaceId: 'workspace-local-github-proof-denied',
        serverUrl: 'https://api.getviewport.test',
        leaseToken: 'lease-secret',
        vpdInstallCommand: 'true',
        workerCommand: 'true',
      });

      expect(record.status).toBe('completed');
      expect(provider.sandboxes[0].commands.at(-1)?.env).not.toHaveProperty(
        'VIEWPORT_ALLOW_LOCAL_GITHUB_TOKEN_FOR_PROOF',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.VIEWPORT_ALLOW_LOCAL_GITHUB_TOKEN_FOR_PROOF;
      } else {
        process.env.VIEWPORT_ALLOW_LOCAL_GITHUB_TOKEN_FOR_PROOF = previous;
      }
    }
  });
});
