import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from '../core/config.js';
import type { WorkflowRunEvent, WorkflowRunRecord } from './types.js';

export class WorkflowRunStore {
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDir = path.join(configDir(), 'runs', 'workflows')) {}

  async save(run: WorkflowRunRecord): Promise<void> {
    const serialized = `${JSON.stringify(run, null, 2)}\n`;
    const previous = this.saveQueues.get(run.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeRun(run.id, serialized));
    this.saveQueues.set(run.id, next);
    try {
      await next;
    } finally {
      if (this.saveQueues.get(run.id) === next) {
        this.saveQueues.delete(run.id);
      }
    }
  }

  private async writeRun(runId: string, serialized: string): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const finalPath = this.runPath(runId);
    const tempPath = path.join(
      this.rootDir,
      `.${runId}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
    );
    await fs.writeFile(tempPath, serialized, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tempPath, finalPath);
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
