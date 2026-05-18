import type { ConfigManager } from '../core/config.js';
import { transportFetch } from '../cli/network.js';
import { resolveConfiguredWorkspaceSyncTarget } from '../cli/context-sync-target.js';
import type { WorkflowRunRecord } from './types.js';
import { runtimeCommands, type WorkflowRuntimeCommand } from './platform-runtime-command.js';
import { buildReviewPacket } from './review-packet.js';
import { workflowRunToSyncPayload } from './platform-sync-payload.js';

type Fetcher = typeof transportFetch;

export interface WorkflowRunPlatformSyncOptions {
  retryDelaysMs?: number[];
  exhaustedRetryDelayMs?: number;
  blockedPollDelayMs?: number;
  onRuntimeCommand?: (
    command: WorkflowRuntimeCommand,
    run: WorkflowRunRecord,
  ) => Promise<boolean | void> | boolean | void;
}

export class WorkflowRunPlatformSync {
  private readonly eventOffsets = new Map<string, number>();
  private readonly latestRuns = new Map<string, WorkflowRunRecord>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly blockedPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly processedCommandIds = new Map<string, Set<string>>();
  private readonly retryDelaysMs: number[];
  private readonly exhaustedRetryDelayMs: number;
  private readonly blockedPollDelayMs: number;
  private readonly onRuntimeCommand?: (
    command: WorkflowRuntimeCommand,
    run: WorkflowRunRecord,
  ) => Promise<boolean | void> | boolean | void;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly fetcher: Fetcher = transportFetch,
    options: WorkflowRunPlatformSyncOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    this.exhaustedRetryDelayMs = options.exhaustedRetryDelayMs ?? 60_000;
    this.blockedPollDelayMs = options.blockedPollDelayMs ?? 3_000;
    this.onRuntimeCommand = options.onRuntimeCommand;
  }

  schedule(run: WorkflowRunRecord): void {
    if (!this.targetFor(run)) return;

    this.latestRuns.set(run.id, cloneRun(run));
    const timer = this.retryTimers.get(run.id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(run.id);
    }
    const blockedPollTimer = this.blockedPollTimers.get(run.id);
    if (blockedPollTimer) {
      clearTimeout(blockedPollTimer);
      this.blockedPollTimers.delete(run.id);
    }
    if (this.workers.has(run.id)) return;
    this.startWorker(run.id);
  }

  async flushPending(): Promise<void> {
    await Promise.all([...this.workers.values()]);
  }

  async sync(run: WorkflowRunRecord): Promise<void> {
    const target = this.targetFor(run);
    if (!target) return;

    const eventOffset = this.eventOffsets.get(run.id) ?? 0;
    const newEvents = run.events.slice(eventOffset);
    const reviewPacket = buildReviewPacket(run);
    const payload = workflowRunToSyncPayload(run, {
      events: newEvents,
      enforceDataCapturePolicy: true,
    });
    const res = await this.fetcher(target.url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        runtime_target_id: target.runtimeTargetId,
        ...payload,
        output_snapshot: collectOutputs(run),
        ...(reviewPacket ? { review_packet: reviewPacket } : {}),
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });

    if (!res.ok) {
      throw new WorkflowPlatformSyncError(
        `workflow platform sync failed: HTTP ${res.status}`,
        isRetryableHttpStatus(res.status),
      );
    }

    await this.applyRuntimeCommands(run, await readResponseJson(res));
    this.eventOffsets.set(run.id, run.events.length);
  }

  private async syncLatest(runId: string): Promise<void> {
    let attempts = 0;

    while (true) {
      const run = this.latestRuns.get(runId);
      if (!run) return;

      try {
        await this.sync(run);
      } catch (error) {
        if (error instanceof WorkflowPlatformSyncError && !error.retryable) {
          this.latestRuns.delete(runId);
          return;
        }
        const delayMs = this.retryDelaysMs[attempts];
        if (delayMs === undefined) {
          this.scheduleExhaustedRetry(runId);
          return;
        }
        attempts += 1;
        await delay(delayMs);
        continue;
      }

      if (this.latestRuns.get(runId) === run) {
        if (run.status === 'blocked') {
          this.scheduleBlockedPoll(runId);
          return;
        }
        this.latestRuns.delete(runId);
        this.processedCommandIds.delete(runId);
        return;
      }
      attempts = 0;
    }
  }

  private startWorker(runId: string): void {
    const worker = this.syncLatest(runId).finally(() => {
      this.workers.delete(runId);
    });
    this.workers.set(runId, worker);
  }

  private scheduleExhaustedRetry(runId: string): void {
    if (!this.latestRuns.has(runId) || this.retryTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(runId);
      if (!this.latestRuns.has(runId) || this.workers.has(runId)) return;
      this.startWorker(runId);
    }, this.exhaustedRetryDelayMs);
    timer.unref?.();
    this.retryTimers.set(runId, timer);
  }

  private scheduleBlockedPoll(runId: string): void {
    if (!this.latestRuns.has(runId) || this.blockedPollTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.blockedPollTimers.delete(runId);
      if (!this.latestRuns.has(runId) || this.workers.has(runId)) return;
      this.startWorker(runId);
    }, this.blockedPollDelayMs);
    timer.unref?.();
    this.blockedPollTimers.set(runId, timer);
  }

  private async applyRuntimeCommands(run: WorkflowRunRecord, body: unknown): Promise<void> {
    if (!this.onRuntimeCommand || run.status !== 'blocked') return;
    const commands = runtimeCommands(body);
    if (commands.length === 0) return;

    const processed = this.processedCommandIds.get(run.id) ?? new Set<string>();
    this.processedCommandIds.set(run.id, processed);
    for (const command of commands) {
      if (processed.has(command.id)) continue;
      const applied = await this.onRuntimeCommand(command, run);
      if (applied === false) continue;
      processed.add(command.id);
    }
  }

  private targetFor(run: WorkflowRunRecord): {
    url: string;
    issueToken: string;
    runtimeTargetId: string;
    tlsVerify?: 'auto' | '0' | '1';
    caCertPath?: string;
    tlsPins?: string[];
  } | null {
    const resourceId = run.resourceId;
    const runtimeTargetId = run.runtimeTargetId;
    if (!resourceId || !runtimeTargetId || !run.platformRunId) return null;

    const daemonConfig = this.configManager.getDaemonConfig();
    if (!daemonConfig) return null;
    const target = resolveConfiguredWorkspaceSyncTarget(daemonConfig, {
      requestedWorkspaceId: resourceId,
    });
    if (!target) return null;
    if (target.runtimeTargetId && target.runtimeTargetId !== runtimeTargetId) {
      return null;
    }

    return {
      url: `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(resourceId)}/workflow-runs/${encodeURIComponent(run.platformRunId)}/sync`,
      issueToken: target.credential,
      runtimeTargetId,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    };
  }
}

class WorkflowPlatformSyncError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkflowPlatformSyncError';
  }
}

function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

function cloneRun(run: WorkflowRunRecord): WorkflowRunRecord {
  return JSON.parse(JSON.stringify(run)) as WorkflowRunRecord;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function collectOutputs(run: WorkflowRunRecord): Record<string, string> {
  return Object.fromEntries(
    Object.values(run.nodes)
      .filter((node) => typeof node.output === 'string' && node.output.length > 0)
      .map((node) => [
        node.id,
        node.type === 'context'
          ? 'Context node output redacted by workflow data capture policy.'
          : (node.output as string),
      ]),
  );
}
