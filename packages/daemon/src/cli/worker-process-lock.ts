import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export interface WorkerLockOptions {
  server: string;
  workspaceId: string;
  executorId: string;
  runnerProfile?: string;
  accessMode: string;
}

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

export interface WorkerProcessLockStatus {
  filePath: string;
  active: boolean;
  pid?: number;
  startedAt?: string;
  stale?: boolean;
}

export interface StopWorkerProcessLockResult extends WorkerProcessLockStatus {
  stopped: boolean;
  signal?: NodeJS.Signals;
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
        `Workflow worker already running for this server/workspace/executor (pid ${existing.pid}). Stop it first, or use \`vpd worker run-once --bootstrap <file>\` for an ephemeral worker.`,
      );
    }

    fs.rmSync(filePath, { force: true });
    const fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.closeSync(fd);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', onExit);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
    const current = readWorkerLock(filePath);
    if (current?.pid === process.pid) {
      fs.rmSync(filePath, { force: true });
    }
  };
  const onExit = (): void => {
    release();
  };
  const exitFromSignal = (code: number): void => {
    release();
    process.exit(code);
  };
  const onSigint = (): void => {
    exitFromSignal(130);
  };
  const onSigterm = (): void => {
    exitFromSignal(143);
  };
  const onSighup = (): void => {
    exitFromSignal(129);
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);

  return { filePath, release };
}

export function inspectWorkerProcessLock(options: WorkerLockOptions): WorkerProcessLockStatus {
  const filePath = workerProcessLockPath(options);
  const record = readWorkerLock(filePath);
  if (!record) {
    return { filePath, active: false };
  }
  if (record.signature !== workerProcessSignature(options)) {
    return { filePath, active: false };
  }
  const active = processIsAlive(record.pid);
  return {
    filePath,
    active,
    pid: record.pid,
    startedAt: record.startedAt,
    stale: !active,
  };
}

export function stopWorkerProcessLock(
  options: WorkerLockOptions,
  signal: NodeJS.Signals = 'SIGTERM',
): StopWorkerProcessLockResult {
  const status = inspectWorkerProcessLock(options);
  if (!status.pid) {
    return { ...status, stopped: false };
  }
  if (!status.active) {
    fs.rmSync(status.filePath, { force: true });
    return { ...status, stopped: false, stale: true };
  }
  process.kill(status.pid, signal);
  return { ...status, stopped: true, signal };
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
    process.env['VIEWPORT_HOME'] ?? process.env['VPD_HOME'] ?? path.join(os.homedir(), '.viewport'),
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
