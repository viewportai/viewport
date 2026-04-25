import { describe, expect, it, vi } from 'vitest';
import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

function createClient(): { client: ConnectedClient; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const client: ConnectedClient = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
  return { client, sent };
}

function createHandlers(daemon: Record<string, unknown>) {
  const sendAck = vi.fn();
  const handlers = createWsCommandHandlers({
    daemon: daemon as any,
    sendAck,
    getOrCreateBuffer: vi.fn() as any,
  });

  return { handlers, sendAck };
}

describe('ws workflow command handlers', () => {
  it('starts browser workflow runs and returns the run id in the ack', async () => {
    const { client, sent } = createClient();
    const run = {
      id: 'run-1',
      status: 'running',
      workflowName: 'proof',
      nodes: {},
      events: [],
    };
    const startRun = vi.fn().mockResolvedValue(run);
    const { handlers, sendAck } = createHandlers({
      workflowRunner: { startRun },
    });

    await handlers['workflow-run'](client, {
      type: 'workflow-run',
      workflowYaml: 'schema: viewport.workflow/v1\nname: proof\nnodes: {}\n',
      workflowSourceRef: 'viewport://templates/proof',
      directoryId: 'dir-1',
      projectId: 'project-1',
      projectMachineBindingId: 'binding-1',
      platformRunId: 'platform-run-1',
      inputs: { focus: 'risk' },
      requestId: 'req-run',
    });

    expect(startRun).toHaveBeenCalledWith({
      workflowPath: undefined,
      workflowYaml: 'schema: viewport.workflow/v1\nname: proof\nnodes: {}\n',
      workflowSourceRef: 'viewport://templates/proof',
      directoryId: 'dir-1',
      inputs: { focus: 'risk' },
      projectId: 'project-1',
      projectMachineBindingId: 'binding-1',
      platformRunId: 'platform-run-1',
      initiation: 'browser',
    });
    expect(sent).toContainEqual({ type: 'workflow-run-started', run });
    expect(sendAck).toHaveBeenCalledWith(client, 'req-run', 'ok', undefined, { runId: 'run-1' });
  });

  it('resolves workflow approvals and sends the updated run detail', async () => {
    const { client, sent } = createClient();
    const run = {
      id: 'run-1',
      status: 'completed',
      workflowName: 'proof',
      nodes: {
        gate: {
          id: 'gate',
          type: 'approval',
          status: 'completed',
          approval: { prompt: 'Ship?', approved: true, requestedAt: 1, resolvedAt: 2 },
        },
      },
      events: [],
    };
    const decideApproval = vi.fn().mockResolvedValue(run);
    const { handlers, sendAck } = createHandlers({
      workflowRunner: { decideApproval },
    });

    await handlers['workflow-approve'](client, {
      type: 'workflow-approve',
      runId: 'run-1',
      nodeId: 'gate',
      approved: true,
      message: 'Approved from test',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'viewport-web',
      },
      requestId: 'req-approve',
    });

    expect(decideApproval).toHaveBeenCalledWith('run-1', 'gate', {
      approved: true,
      message: 'Approved from test',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'viewport-web',
      },
    });
    expect(sent).toContainEqual({ type: 'workflow-run-detail', run });
    expect(sendAck).toHaveBeenCalledWith(client, 'req-approve', 'ok', undefined, {
      runId: 'run-1',
      nodeId: 'gate',
    });
  });

  it('returns an input error when workflow approval cannot be resolved', async () => {
    const { client } = createClient();
    const decideApproval = vi.fn().mockRejectedValue(new Error('Approval node is not blocked'));
    const { handlers, sendAck } = createHandlers({
      workflowRunner: { decideApproval },
    });

    await handlers['workflow-approve'](client, {
      type: 'workflow-approve',
      runId: 'run-1',
      nodeId: 'gate',
      approved: false,
      requestId: 'req-approve',
    });

    expect(sendAck).toHaveBeenCalledWith(
      client,
      'req-approve',
      'error',
      'Approval node is not blocked',
      { errorCode: 'INVALID_INPUT' },
    );
  });
});
