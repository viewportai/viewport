import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from '../core/config.js';
import type { WorkflowNodeRunState, WorkflowRunEvent, WorkflowRunRecord } from './types.js';

export class WorkflowRunStore {
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDir = path.join(configDir(), 'runs', 'workflows')) {}

  async save(run: WorkflowRunRecord): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(run)) as WorkflowRunRecord;
    const previous = this.saveQueues.get(run.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeRun(run.id, snapshot));
    this.saveQueues.set(run.id, next);
    try {
      await next;
    } finally {
      if (this.saveQueues.get(run.id) === next) {
        this.saveQueues.delete(run.id);
      }
    }
  }

  private async writeRun(runId: string, snapshot: WorkflowRunRecord): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const finalPath = this.runPath(runId);
    const tempPath = path.join(
      this.rootDir,
      `.${runId}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
    );
    const merged = await this.mergeExistingRun(snapshot);
    await fs.writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tempPath, finalPath);
  }

  private async mergeExistingRun(snapshot: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    const existing = await this.get(snapshot.id);
    if (!existing) return snapshot;

    const events = new Map(snapshot.events.map((event) => [event.id, event]));
    for (const event of existing.events) {
      if (!events.has(event.id)) events.set(event.id, event);
    }
    const nodes = mergeExistingTerminalNodes(snapshot.nodes, existing.nodes);
    return {
      ...snapshot,
      nodes,
      ...mergeExistingTerminalRun(snapshot, existing),
      events: [...events.values()].sort((a, b) => a.timestamp - b.timestamp),
      startedAt: mergeStartedAt(snapshot.startedAt, existing.startedAt),
      updatedAt: Math.max(snapshot.updatedAt, existing.updatedAt),
    };
  }

  async appendEvent(runId: string, event: WorkflowRunEvent): Promise<WorkflowRunRecord> {
    const run = await this.get(runId);
    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }
    run.events.push(event);
    run.updatedAt = event.timestamp;
    await this.save(run);
    return run;
  }

  async get(runId: string): Promise<WorkflowRunRecord | null> {
    try {
      const raw = await fs.readFile(this.runPath(runId), 'utf-8');
      return JSON.parse(raw) as WorkflowRunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async list(limit = 50): Promise<WorkflowRunRecord[]> {
    try {
      const entries = await fs.readdir(this.rootDir);
      const runs = await Promise.all(
        entries
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const raw = await fs.readFile(path.join(this.rootDir, name), 'utf-8');
            return JSON.parse(raw) as WorkflowRunRecord;
          }),
      );
      return runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private runPath(runId: string): string {
    return path.join(this.rootDir, `${runId}.json`);
  }
}

function mergeExistingTerminalNodes(
  snapshot: WorkflowRunRecord['nodes'],
  existing: WorkflowRunRecord['nodes'],
): WorkflowRunRecord['nodes'] {
  const nodes = { ...snapshot };
  for (const [nodeId, existingNode] of Object.entries(existing)) {
    const snapshotNode = nodes[nodeId];
    if (!snapshotNode) {
      nodes[nodeId] = existingNode;
      continue;
    }
    if (shouldPreserveExistingNode(snapshotNode, existingNode)) {
      nodes[nodeId] = existingNode;
    }
  }
  return nodes;
}

function shouldPreserveExistingNode(
  snapshotNode: WorkflowNodeRunState,
  existingNode: WorkflowNodeRunState,
): boolean {
  if (!isTerminalNodeStatus(existingNode.status)) return false;
  if (existingNode.status === 'canceled' && snapshotNode.status !== 'canceled') return true;
  if (!isTerminalNodeStatus(snapshotNode.status)) return true;
  return (existingNode.completedAt ?? 0) > (snapshotNode.completedAt ?? 0);
}

function mergeExistingTerminalRun(
  snapshot: WorkflowRunRecord,
  existing: WorkflowRunRecord,
): Partial<WorkflowRunRecord> {
  if (!isTerminalRunStatus(existing.status)) return {};
  if (existing.status === 'canceled' && snapshot.status !== 'canceled') {
    return {
      status: existing.status,
      completedAt: existing.completedAt,
      error: existing.error,
    };
  }
  if (isTerminalRunStatus(snapshot.status)) {
    return (existing.completedAt ?? 0) > (snapshot.completedAt ?? 0)
      ? {
          status: existing.status,
          completedAt: existing.completedAt,
          error: existing.error,
        }
      : {};
  }

  return {
    status: existing.status,
    completedAt: existing.completedAt,
    error: existing.error,
  };
}

function isTerminalNodeStatus(status: WorkflowNodeRunState['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'skipped' || status === 'canceled'
  );
}

function isTerminalRunStatus(status: WorkflowRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function mergeStartedAt(
  snapshotStartedAt?: number,
  existingStartedAt?: number,
): number | undefined {
  if (snapshotStartedAt === undefined) return existingStartedAt;
  if (existingStartedAt === undefined) return snapshotStartedAt;
  return Math.min(snapshotStartedAt, existingStartedAt);
}
