import type { ConfigManager } from '../core/config.js';
import { transportFetch } from '../cli/network.js';
import type { WorkflowRunEvent, WorkflowRunRecord } from './types.js';

type Fetcher = typeof transportFetch;

export class WorkflowRunPlatformSync {
  private readonly eventOffsets = new Map<string, number>();

  constructor(
    private readonly configManager: ConfigManager,
    private readonly fetcher: Fetcher = transportFetch,
  ) {}

  async sync(run: WorkflowRunRecord): Promise<void> {
    const target = this.targetFor(run);
    if (!target) return;

    const eventOffset = this.eventOffsets.get(run.id) ?? 0;
    const newEvents = run.events.slice(eventOffset);
    const res = await this.fetcher(target.url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        project_machine_binding_id: target.projectMachineBindingId,
        runtime_run_id: run.id,
        status: run.status,
        output_snapshot: collectOutputs(run),
        error_summary: run.error ?? null,
        completed_at: run.completedAt ? new Date(run.completedAt).toISOString() : null,
        nodes: Object.values(run.nodes).map((node) => ({
          node_key: node.id,
          title: node.title ?? node.id,
          type: node.type,
          status: node.status,
          session_id: node.sessionId ?? null,
          worktree_path: node.worktreePath ?? null,
          output: node.output ?? null,
          error: node.error ?? null,
          started_at: node.startedAt ? new Date(node.startedAt).toISOString() : null,
          completed_at: node.completedAt ? new Date(node.completedAt).toISOString() : null,
          metadata: {
            ...(node.metadata ?? {}),
            approval: node.approval ?? null,
            nativeSessionId: node.nativeSessionId ?? null,
            exitCode: node.exitCode ?? null,
          },
        })),
        artifacts: run.artifacts.map((artifact) => ({
          node_key: artifact.nodeId,
          name: artifact.name,
          kind: artifact.kind ?? null,
          path: artifact.path,
          uri: null,
          mime_type: null,
          digest: artifact.digest ?? readString(artifact.metadata?.['digest']),
          metadata: {
            ...(artifact.metadata ?? {}),
            description: artifact.description ?? null,
            sizeBytes: artifact.sizeBytes ?? null,
          },
        })),
        ...(newEvents.length > 0 ? { events: newEvents.map(formatEvent) } : {}),
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });

    if (!res.ok) {
      throw new Error(`workflow platform sync failed: HTTP ${res.status}`);
    }

    this.eventOffsets.set(run.id, run.events.length);
  }

  private targetFor(run: WorkflowRunRecord): {
    url: string;
    issueToken: string;
    projectMachineBindingId: string;
    tlsVerify?: 'auto' | '0' | '1';
    caCertPath?: string;
    tlsPins?: string[];
  } | null {
    if (!run.projectId || !run.projectMachineBindingId || !run.platformRunId) return null;

    const daemonConfig = this.configManager.getDaemonConfig();
    const server = daemonConfig?.server ?? {};
    const relay = daemonConfig?.relay ?? {};
    const serverUrl = relay.serverUrl ?? server.url;
    const issueToken = relay.issueToken;

    if (!serverUrl || !issueToken) return null;
    if (relay.workspaceId && relay.workspaceId !== run.projectId) return null;
    if (
      relay.projectMachineBindingId &&
      relay.projectMachineBindingId !== run.projectMachineBindingId
    ) {
      return null;
    }

    return {
      url: `${serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(run.projectId)}/workflow-runs/${encodeURIComponent(run.platformRunId)}/sync`,
      issueToken,
      projectMachineBindingId: run.projectMachineBindingId,
      tlsVerify: server.tlsVerify,
      caCertPath: server.caCertPath,
      tlsPins: server.tlsPins,
    };
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function collectOutputs(run: WorkflowRunRecord): Record<string, string> {
  return Object.fromEntries(
    Object.values(run.nodes)
      .filter((node) => typeof node.output === 'string' && node.output.length > 0)
      .map((node) => [node.id, node.output as string]),
  );
}

function formatEvent(event: WorkflowRunEvent) {
  return {
    node_key: event.nodeId ?? null,
    type: event.type,
    severity: eventSeverity(event),
    message: event.message,
    payload: event.data ?? null,
    occurred_at: new Date(event.timestamp).toISOString(),
  };
}

function eventSeverity(event: WorkflowRunEvent): 'debug' | 'info' | 'warning' | 'error' {
  if (event.type.includes('failed') || event.type.includes('error')) return 'error';
  if (event.type.includes('blocked') || event.type.includes('missing')) return 'warning';
  return 'info';
}
