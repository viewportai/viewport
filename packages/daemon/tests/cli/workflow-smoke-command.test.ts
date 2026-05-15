import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('workflow smoke CLI', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.resetModules();
    logSpy.mockClear();
  });

  afterEach(async () => {
    process.argv = originalArgv;
    vi.doUnmock('../../src/cli/daemon-client.js');
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('starts and polls a local shell smoke workflow', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-workflow-smoke-'));
    process.argv = ['node', 'vpd', 'workflow', 'smoke', '--path', tempDir];
    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/directories') {
        return jsonResponse([{ id: 'dir_1', path: tempDir }]);
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          workflowSourceRef: 'viewport://workflow-smoke/local',
          directoryId: 'dir_1',
          initiation: 'cli',
        });
        expect(body.workflowYaml).toContain('type: shell');
        expect(body.workflowYaml).toContain('Local shell smoke');
        expect(body.workflowYaml).toContain('command: "printf VIEWPORT_WORKFLOW_SMOKE_');
        return jsonResponse({ run: smokeRun('running') });
      }
      if (urlPath === '/api/workflows/runs/run_smoke') {
        return jsonResponse({ run: smokeRun('completed') });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(String(logSpy.mock.calls.flat().join('\n'))).toContain('Workflow run: run_smoke');
    expect(String(logSpy.mock.calls.flat().join('\n'))).toContain('Smoke:');
  });

  it('can target a specific agent for runner capability smoke', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-workflow-smoke-'));
    process.argv = ['node', 'vpd', 'workflow', 'smoke', '--path', tempDir, '--agent', 'custom'];
    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/directories') {
        return jsonResponse([{ id: 'dir_1', path: tempDir }]);
      }
      if (urlPath === '/api/agents') {
        return jsonResponse({
          agents: [{ id: 'custom', displayName: 'Custom agent', available: true }],
        });
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.workflowYaml).toContain('type: agent');
        expect(body.workflowYaml).toContain('agent: "custom"');
        expect(body.workflowYaml).toContain('requires:');
        return jsonResponse({ run: smokeRun('completed', 'viewport-agent-smoke') });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(String(logSpy.mock.calls.flat().join('\n'))).toContain(
      'Workflow:     viewport-agent-smoke',
    );
  });

  it('refuses an agent smoke when the daemon cannot launch that agent', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-workflow-smoke-'));
    process.argv = ['node', 'vpd', 'workflow', 'smoke', '--path', tempDir, '--agent', 'codex'];
    const daemonFetch = vi.fn(async (urlPath: string) => {
      if (urlPath === '/api/directories') {
        return jsonResponse([{ id: 'dir_1', path: tempDir }]);
      }
      if (urlPath === '/api/agents') {
        return jsonResponse({
          agents: [{ id: 'codex', displayName: 'Codex', available: false }],
        });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await expect(workflow()).rejects.toThrow("Daemon cannot launch workflow agent 'codex'");

    expect(daemonFetch).not.toHaveBeenCalledWith('/api/workflows/runs', expect.anything());
  });
});

function smokeRun(status: string, workflowName = 'viewport-smoke') {
  return {
    id: 'run_smoke',
    workflowName,
    digest: 'sha256:smoke',
    status,
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://workflow-smoke/local',
    nodes: {},
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
