import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import {
  waitForCompletedRun,
  waitForRunState,
  waitForTerminalRun,
} from './support/workflow-runner-support.js';

let tempHome: string;
let projectDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;
const originalFetch = global.fetch;

async function setup(): Promise<Daemon> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-actions-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-actions-project-'));
  originalHome = process.env['HOME'];
  originalCodexHome = process.env['CODEX_HOME'];
  process.env['HOME'] = tempHome;
  process.env['CODEX_HOME'] = path.join(tempHome, '.codex');

  const daemon = new Daemon();
  await daemon.initialize();
  await daemon.directoryManager.register(projectDir);
  return daemon;
}

async function cleanup(): Promise<void> {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
}

describe('workflow runner action adapters', () => {
  afterEach(cleanup);

  it('executes a generic webhook action and records response evidence', async () => {
    const fetchMock = vi.fn(async () => new Response('accepted', { status: 202 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: webhook-action-proof
inputs:
  issue: { type: string, required: true }
nodes:
  notify:
    type: action
    adapter: webhook
    action: post
    with:
      url: https://hooks.example.test/workflow
      headers:
        X-Viewport-Test: yes
      body:
        issue: "{{ inputs.issue }}"
        status: ready
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      inputs: { issue: 'PAY-1842' },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.test/workflow',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Viewport-Test': 'yes' }),
        body: JSON.stringify({ issue: 'PAY-1842', status: 'ready' }),
      }),
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.notify?.output).toBe('webhook.post 202');
    expect(completed?.nodes.notify?.metadata?.action).toMatchObject({
      adapter: 'webhook',
      action: 'post',
      status: 'executed',
      response: { status: 202, ok: true, bodyExcerpt: 'accepted' },
    });
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'action-executed',
        nodeId: 'notify',
      }),
    );
  });

  it('blocks approved side-effect actions until approval, then executes on resume', async () => {
    const fetchMock = vi.fn(async () => new Response('approved action', { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: action-approval-proof
nodes:
  post_approval:
    type: action
    adapter: webhook
    action: post
    requiresApproval: true
    with:
      url: https://hooks.example.test/workflow
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const blocked = await waitForRunState(
      daemon,
      run.id,
      (candidate) =>
        candidate.status === 'blocked' && candidate.nodes.post_approval?.status === 'blocked',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(blocked.nodes.post_approval?.approval?.prompt).toBe('Approve webhook.post side effect?');
    expect(blocked.nodes.post_approval?.metadata?.action).toMatchObject({
      adapter: 'webhook',
      action: 'post',
      status: 'awaiting_approval',
      requiresApproval: true,
    });

    await daemon.workflowRunner.decideApproval(run.id, 'post_approval', {
      approved: true,
      message: 'Approved by test',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'unit-test',
      },
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.test/workflow',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.post_approval?.metadata?.action).toMatchObject({
      adapter: 'webhook',
      action: 'post',
      status: 'executed',
      requiresApproval: true,
    });
  });
});
