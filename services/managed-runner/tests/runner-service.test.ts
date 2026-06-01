import { describe, expect, it } from 'vitest';
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
});
