import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from '../core/config.js';

export interface WorkflowSessionLink {
  sessionId: string;
  nativeSessionId?: string;
  workflowRunId: string;
  workflowNodeId: string;
  parentDirectoryId: string;
  parentDirectoryPath: string;
  worktreePath: string;
  createdAt: number;
  updatedAt: number;
}

export class WorkflowSessionLinkStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly filePath = path.join(configDir(), 'runs', 'workflow-session-links.json'),
  ) {}

  async upsert(link: WorkflowSessionLink): Promise<void> {
    await this.enqueueWrite(async () => {
      const links = await this.list();
      const index = links.findIndex((item) => item.sessionId === link.sessionId);
      if (index >= 0) {
        links[index] = {
          ...links[index],
          ...link,
          createdAt: links[index]?.createdAt ?? link.createdAt,
          updatedAt: Date.now(),
        };
      } else {
        links.push(link);
      }
      await this.save(links);
    });
  }

  async list(): Promise<WorkflowSessionLink[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isWorkflowSessionLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  private async enqueueWrite(write: () => Promise<void>): Promise<void> {
    const previous = WorkflowSessionLinkStore.writeQueues.get(this.filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    WorkflowSessionLinkStore.writeQueues.set(this.filePath, next);
    try {
      await next;
    } finally {
      if (WorkflowSessionLinkStore.writeQueues.get(this.filePath) === next) {
        WorkflowSessionLinkStore.writeQueues.delete(this.filePath);
      }
    }
  }

  private async save(links: WorkflowSessionLink[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(links, null, 2)}\n`, 'utf-8');
    await fs.rename(tempPath, this.filePath);
  }
}

function isWorkflowSessionLink(value: unknown): value is WorkflowSessionLink {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === 'string' &&
    (record.nativeSessionId === undefined || typeof record.nativeSessionId === 'string') &&
    typeof record.workflowRunId === 'string' &&
    typeof record.workflowNodeId === 'string' &&
    typeof record.parentDirectoryId === 'string' &&
    typeof record.parentDirectoryPath === 'string' &&
    typeof record.worktreePath === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  );
}
