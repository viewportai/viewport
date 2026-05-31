import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ManagedWorkerOptions } from './workflow-managed-worker-types.js';

type WorkerLockOptions = Pick<
  ManagedWorkerOptions,
  'server' | 'workspaceId' | 'executorId' | 'runnerProfile' | 'accessMode'
>;

interface WorkerLockRecord {
  schema: 'viewport.worker_process_lock/v1';
  pid: number;
  signature: string;
  startedAt: string;
}

export interface WorkerProcessLock {
  filePath: string;
  release: () => void;
}

export function acquireWorkerProcessLock(options: WorkerLockOptions): WorkerProcessLock {
  const filePath = workerProcessLockPath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const record: WorkerLockRecord = {
    schema: 'viewport.worker_process_lock/v1',
    pid: process.pid,
    signature: workerProcessSignature(options),
    startedAt: new Date().toISOString(),
  };

  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }

    const existing = readWorkerLock(filePath);
    if (existing && processIsAlive(existing.pid)) {
      throw new Error(
        `Workflow worker already running for this server/workspace/executor (pid ${existing.pid}). Stop it first, or run with --once for a one-shot worker.`,
      );
    }

    fs.rmSync(filePath, { force: true });
    const fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
  }

  return {
    filePath,
    release: () => {
      const current = readWorkerLock(filePath);
      if (current?.pid === process.pid) {
        fs.rmSync(filePath, { force: true });
      }
    },
  };
}

export function workerProcessLockPath(options: WorkerLockOptions): string {
  const digest = workerProcessSignature(options).slice(0, 24);

  return path.join(viewportHome(), 'worker-locks', `${digest}.json`);
}

function workerProcessSignature(options: WorkerLockOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        server: options.server.replace(/\/+$/, ''),
        workspaceId: options.workspaceId,
        executorId: options.executorId,
        runnerProfile: options.runnerProfile ?? null,
        accessMode: options.accessMode,
      }),
    )
    .digest('hex');
}

function viewportHome(): string {
  return path.resolve(
    process.env['VIEWPORT_HOME'] ??
      process.env['VPD_HOME'] ??
      path.join(os.homedir(), '.viewport'),
  );
}

function readWorkerLock(filePath: string): WorkerLockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Partial<WorkerLockRecord>;
    if (record.schema !== 'viewport.worker_process_lock/v1' || typeof record.pid !== 'number') {
      return null;
    }

    return record as WorkerLockRecord;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}
