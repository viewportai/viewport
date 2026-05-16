import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

describe('workflow approve CLI', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.resetModules();
    logSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.doUnmock('../../src/cli/daemon-client.js');
  });

  it('sends explicit approve decisions with expected action digests', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'approve',
      'run_1',
      'open_pr',
      '--expected-action-digest',
      'sha256:reviewed',
      '--message',
      'Looks safe',
    ];

    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/workflows/runs/run_1/approvals/open_pr' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          approved: true,
          decision: 'approve',
          expectedActionDigest: 'sha256:reviewed',
          message: 'Looks safe',
          actor: { name: 'Local CLI', source: 'vpd-cli' },
        });
        return jsonResponse({ run: workflowRun('completed') });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(String(logSpy.mock.calls.flat().join('\n'))).toContain('Workflow run: run_1');
  });

  it('sends request-changes decisions without approving the side effect', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'approve',
      'run_1',
      'open_pr',
      '--request-changes',
      '--digest',
      'sha256:reviewed',
    ];

    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/workflows/runs/run_1/approvals/open_pr' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          approved: false,
          decision: 'request_changes',
          expectedActionDigest: 'sha256:reviewed',
        });
        return jsonResponse({ run: workflowRun('canceled') });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();
  });

  it('refuses ambiguous negative decisions', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'approve',
      'run_1',
      'open_pr',
      '--request-changes',
      '--reject',
    ];

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch: vi.fn(),
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await expect(workflow()).rejects.toThrow('Use only one of --request-changes');
  });
});

function workflowRun(status: string) {
  return {
    id: 'run_1',
    workflowName: 'approval-proof',
    digest: 'sha256:workflow',
    status,
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://workflow/approval-proof',
    nodes: {},
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
