import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import YAML from 'yaml';
import { ConfigManager } from '../core/config.js';
import { Daemon } from '../core/daemon.js';
import { loadAgents } from '../startup-agents.js';
import { envNameForCredentialRef } from '../workflows/action-provider-utils.js';
import { GitTracker } from '../tracking/git-tracker.js';
import { workflowRunToSyncPayload } from '../workflows/platform-sync-payload.js';
import { WorkflowRunStore } from '../workflows/store.js';
import type {
  WorkflowDataCapturePolicy,
  WorkflowInputValue,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from '../workflows/types.js';
import { transportFetch } from './network.js';
import type {
  ManagedSessionVerificationCommand,
  ManagedSessionVerificationContract,
} from './managed-session-verification-contract.js';
import { acquireWorkerProcessLock } from './worker-process-lock.js';
import {
  readWorkerPairingRecord,
  workerProfileIntegrity,
  type WorkerLifecycle,
  type WorkerTransport as WorkerTransportMode,
} from './worker-profile.js';

export interface StandaloneWorkerOptions {
  lifecycle: WorkerLifecycle;
  transport?: WorkerTransportMode;
  once: boolean;
  leaseToken?: string;
  bootstrapPath?: string;
  registrationProfilePath?: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
}

export interface StandaloneWorkerResult {
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
  cleanup: number;
  denied: number;
}

interface WorkerRuntimeProfile {
  serverUrl: string;
  serverId?: string;
  lifecycle: WorkerLifecycle;
  transport: WorkerTransportMode;
  inbound?: {
    enabled?: boolean;
    signedRequests?: boolean;
    replayProtection?: boolean;
    controlPlaneClaimVerify?: boolean;
  };
  workspaceId?: string;
  managedExecutorId?: string;
  credential?: string;
  relayWsBaseUrl?: string;
  workspaceRoot: string;
  identityKeyPath: string;
  publicKeyFingerprint: string;
  capabilities: Record<string, unknown>;
}

interface WorkerRuntimeBootstrap {
  profile: WorkerRuntimeProfile;
  lease?: ClaimedLease;
  cleanup?: () => Promise<void>;
}

interface WorkerIdentityFile {
  version?: number;
  algorithm?: string;
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
  createdAt?: string;
}

interface ManagedExecutorRegistrationProfile {
  serverUrl?: string;
  serverId?: string;
  workspaceId?: string;
  executorId?: string;
  credential?: string;
  credentialFile?: string;
  accessMode?: string;
  runnerProfile?: string;
  runnerPosture?: Record<string, unknown>;
  workspaceRoot?: string;
  identityKeyPath?: string;
  capabilities?: Record<string, unknown>;
}

interface ClaimedLease {
  id: string;
  agentSessionId?: string;
  runId?: string;
  runtimeRunId?: string;
  leaseToken?: string;
  assignmentClaimToken?: string;
  sessionVerificationContract?: ManagedSessionVerificationContract;
  gateway?: GatewayLease;
  yamlSnapshot?: string;
  sourceRef?: string;
  directoryPath?: string;
  inputSnapshot?: Record<string, WorkflowInputValue>;
  resourceManifest?: Record<string, unknown>;
  workflowAuthorityContract?: Record<string, unknown>;
  executionProfileSnapshot?: Record<string, unknown>;
  workflowSnapshot?: Record<string, unknown>;
  runtimeTargetId?: string;
  dataCapturePolicy?: WorkflowDataCapturePolicy;
}

function runtimeContextTargetIdValue(
  primary: Record<string, unknown> | undefined,
  fallback?: Record<string, unknown> | undefined,
): string | undefined {
  return stringValue(
    primary?.['runtime_context_target_id'] ??
      primary?.['runtimeContextTargetId'] ??
      primary?.['runtime_target_id'] ??
      primary?.['runtimeTargetId'] ??
      fallback?.['runtime_context_target_id'] ??
      fallback?.['runtimeContextTargetId'] ??
      fallback?.['runtime_target_id'] ??
      fallback?.['runtimeTargetId'],
  );
}

function hostedRuntimeContextTargetId(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
): string | undefined {
  return (
    lease.runtimeTargetId ??
    (profile.managedExecutorId ? `managed_executor:${profile.managedExecutorId}` : undefined)
  );
}

function hostedWorkflowInputs(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
): Record<string, WorkflowInputValue> | undefined {
  const base = { ...(lease.inputSnapshot ?? {}) } as Record<string, WorkflowInputValue>;
  const runtimeTargetId = hostedRuntimeContextTargetId(profile, lease);
  if (
    !profile.serverUrl ||
    !profile.workspaceId ||
    !lease.assignmentClaimToken ||
    !runtimeTargetId
  ) {
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const viewport = isWorkflowInputRecord(base['viewport']) ? { ...base['viewport'] } : {};
  viewport['runtimeContextTarget'] = {
    schema: 'viewport.runtime_context_target/v1',
    serverUrl: profile.serverUrl,
    workspaceId: profile.workspaceId,
    runtimeTargetId,
    credential: lease.assignmentClaimToken,
  };
  base['viewport'] = viewport;

  return base;
}

function isWorkflowInputRecord(
  value: WorkflowInputValue | undefined,
): value is Record<string, WorkflowInputValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

interface GatewayLease {
  gatewayBaseUrl: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  modelAllow: string[];
  virtualKey: {
    token: string;
  };
}

interface HostedClaimExecutionResult {
  status: Extract<WorkflowRunStatus, 'completed' | 'failed' | 'blocked' | 'canceled'>;
  run?: WorkflowRunRecord;
  daemon?: Daemon;
  failure?: HostedWorkerFailure;
}

interface HostedWorkerFailure {
  errorCode: string;
  failureClass: string;
  summary: string;
  nextCheck: string;
  retrySafe: boolean;
}

interface HostedAssignmentCommandPoll {
  runtime_commands?: unknown;
  _viewport_worker_retry?: boolean;
}

interface HostedManagedExecutorRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  requestPath: string;
  url: string;
  serialized: string;
  headers: Record<string, string>;
}

type HostedManagedExecutorDispatcher = (request: HostedManagedExecutorRequest) => Promise<Response>;

export interface WorkerTransport {
  readonly mode: WorkerTransportMode;
  claim(body: Record<string, unknown>): Promise<ClaimedLease | null>;
  heartbeat(options: {
    status: 'online' | 'offline';
    healthStatus: 'idle' | 'offline';
    lifecycle: WorkerLifecycle;
  }): Promise<void>;
  sync(lease: ClaimedLease, execution: HostedClaimExecutionResult): Promise<void>;
  cleanup(lease: ClaimedLease): Promise<void>;
  pollRuntimeCommands(lease: ClaimedLease): Promise<HostedAssignmentCommandPoll>;
}

class HttpPollingTransport implements WorkerTransport {
  constructor(
    private readonly profile: WorkerRuntimeProfile,
    public readonly mode: WorkerTransportMode,
  ) {}

  claim(body: Record<string, unknown>): Promise<ClaimedLease | null> {
    return claimLeaseHttp(this.profile, body);
  }

  heartbeat(options: {
    status: 'online' | 'offline';
    healthStatus: 'idle' | 'offline';
    lifecycle: WorkerLifecycle;
  }): Promise<void> {
    return heartbeatHttp(this.profile, {
      ...options,
      transport: this.mode,
    });
  }

  sync(lease: ClaimedLease, execution: HostedClaimExecutionResult): Promise<void> {
    return syncLeaseHttp(this.profile, lease, execution);
  }

  cleanup(lease: ClaimedLease): Promise<void> {
    return cleanupLeaseHttp(this.profile, lease);
  }

  pollRuntimeCommands(lease: ClaimedLease): Promise<HostedAssignmentCommandPoll> {
    return fetchHostedAssignmentHttp(this.profile, lease);
  }
}

class RelayWorkerTransport implements WorkerTransport {
  public readonly mode: WorkerTransportMode = 'relay';
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly profile: WorkerRuntimeProfile) {}

  async claim(body: Record<string, unknown>): Promise<ClaimedLease | null> {
    return claimLeaseHttp(this.profile, body, (request) =>
      this.dispatchHostedManagedExecutorRequest(request),
    );
  }

  async heartbeat(options: {
    status: 'online' | 'offline';
    healthStatus: 'idle' | 'offline';
    lifecycle: WorkerLifecycle;
  }): Promise<void> {
    return heartbeatHttp(
      this.profile,
      {
        ...options,
        transport: 'relay',
      },
      (request) => this.dispatchHostedManagedExecutorRequest(request),
    );
  }

  async sync(lease: ClaimedLease, execution: HostedClaimExecutionResult): Promise<void> {
    return syncLeaseHttp(this.profile, lease, execution, (request) =>
      this.dispatchHostedManagedExecutorRequest(request),
    );
  }

  async cleanup(lease: ClaimedLease): Promise<void> {
    return cleanupLeaseHttp(this.profile, lease);
  }

  async pollRuntimeCommands(lease: ClaimedLease): Promise<HostedAssignmentCommandPoll> {
    return fetchHostedAssignmentHttp(this.profile, lease, (request) =>
      this.dispatchHostedManagedExecutorRequest(request),
    );
  }

  async dispatchHostedManagedExecutorRequest(
    request: HostedManagedExecutorRequest,
  ): Promise<Response> {
    const ws = await this.connection();
    const requestId = crypto.randomUUID();
    const frame = {
      type: 'viewport.worker_transport.request/v1',
      requestId,
      method: request.method,
      path: request.requestPath,
      headers: request.headers,
      body: request.serialized,
    };
    return new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Relay worker transport request ${request.path} timed out.`));
      }, relayWorkerRequestTimeoutMs());
      this.pending.set(requestId, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame), (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(requestId);
          reject(error);
        }
      });
    });
  }

  private async connection(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    if (!isHostedManagedExecutorProfile(this.profile)) {
      throw new Error('Relay worker transport requires a hosted managed executor profile.');
    }
    const tokenResponse = await hostedManagedExecutorFetch(this.profile, 'POST', 'relay-token', {
      credential: this.profile.credential,
      ttl_seconds: 3600,
    });
    const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
    const token = stringValue(tokenPayload['relayToken']);
    const claims = recordValue(tokenPayload['claims']);
    const claimRelayWsBaseUrl = stringValue(claims?.['relayWsBaseUrl']);
    if (!token) {
      throw new Error('Relay worker transport token response did not include a relay token.');
    }
    const relayWsBaseUrl =
      this.profile.relayWsBaseUrl ??
      process.env['VIEWPORT_RELAY_WS_BASE_URL'] ??
      process.env['VPD_RELAY_WS_BASE_URL'] ??
      claimRelayWsBaseUrl ??
      relayWsBaseUrlFromServerUrl(this.profile.serverUrl);
    const url = new URL(relayWsBaseUrl);
    url.searchParams.set('role', 'worker');
    url.searchParams.set('workspaceId', this.profile.workspaceId!);

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Relay worker transport connection timed out.')),
        relayWorkerConnectionTimeoutMs(),
      );
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    ws.on('message', (raw) => {
      this.handleMessage(raw.toString('utf8'));
    });
    ws.on('close', () => {
      for (const [requestId, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Relay worker transport connection closed.'));
        this.pending.delete(requestId);
      }
      this.ws = null;
    });

    this.ws = ws;
    return ws;
  }

  private handleMessage(text: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame['type'] !== 'viewport.worker_transport.response/v1') return;
    const requestId = stringValue(frame['requestId']);
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    const status = typeof frame['status'] === 'number' ? frame['status'] : 502;
    const headers = recordValue(frame['headers']) as Record<string, string> | undefined;
    const body = typeof frame['body'] === 'string' ? frame['body'] : '';
    const responseBody = status === 204 || status === 205 || status === 304 ? null : body;
    pending.resolve(new Response(responseBody, { status, headers }));
  }
}

const DEFAULT_HOSTED_LEASE_SECONDS = 1_800;

export async function runStandaloneWorker(
  options: StandaloneWorkerOptions,
): Promise<StandaloneWorkerResult> {
  const bootstrap = await loadWorkerRuntimeBootstrap(
    options.bootstrapPath,
    options.registrationProfilePath,
  );
  const profile = bootstrap.profile;
  let processLock: ReturnType<typeof acquireWorkerProcessLock> | null = null;

  try {
    await validateWorkerWorkspaceRoot(profile.workspaceRoot);
    const transport = options.transport ?? profile.transport;
    if (transport === 'inbound') {
      validateInboundWorkerGate(profile);
    }
    const workerTransport =
      transport === 'relay'
        ? new RelayWorkerTransport(profile)
        : new HttpPollingTransport(profile, transport);
    processLock =
      options.lifecycle === 'persistent' && !options.once
        ? acquireWorkerProcessLock({
            server: profile.serverUrl,
            workspaceId: profile.workspaceId ?? profile.publicKeyFingerprint,
            executorId: profile.managedExecutorId ?? profile.publicKeyFingerprint,
            runnerProfile: runnerPoolFromCapabilities(profile.capabilities),
            accessMode: transport,
          })
        : null;
    let lastHeartbeatAt = Date.now();
    await workerTransport.heartbeat({
      status: 'online',
      healthStatus: 'idle',
      lifecycle: options.lifecycle,
    });

    if (bootstrap.lease) {
      const result = await executeBootstrapLease(profile, workerTransport, bootstrap.lease);
      await workerTransport.heartbeat({
        status: 'offline',
        healthStatus: 'offline',
        lifecycle: options.lifecycle,
      });
      return result;
    }

    if (options.leaseToken) {
      throw new Error(
        '`vpd worker run-once --lease` no longer fabricates a completed sync (EXEC-01). ' +
          'Use `vpd worker run-once --bootstrap <file>` to execute the leased work.',
      );
    }

    const result: StandaloneWorkerResult = {
      claimed: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
      cleanup: 0,
      denied: 0,
    };
    try {
      while (!options.abortSignal?.aborted) {
        const lease = await workerTransport.claim({
          lifecycle: options.lifecycle,
          transport,
          leaseSeconds: options.leaseSeconds,
        });
        if (!lease) {
          if (options.once || options.lifecycle !== 'persistent') break;
          const now = Date.now();
          if (now - lastHeartbeatAt > 30_000) {
            await workerTransport.heartbeat({
              status: 'online',
              healthStatus: 'idle',
              lifecycle: options.lifecycle,
            });
            lastHeartbeatAt = now;
          }
          await sleepWithAbort(options.pollIntervalMs ?? 5_000, options.abortSignal);
          continue;
        }
        result.claimed += 1;
        let execution = await executeClaim(profile, workerTransport, lease);
        if (
          isHostedManagedExecutorProfile(profile) &&
          execution.status === 'blocked' &&
          execution.run
        ) {
          await workerTransport.sync(lease, execution);
          execution = await resumeBlockedHostedExecution(
            profile,
            workerTransport,
            lease,
            execution,
          );
          if (execution.status !== 'blocked') {
            await workerTransport.sync(lease, execution);
          }
        } else {
          await workerTransport.sync(lease, execution);
        }
        await maybeExecuteHostedSessionVerification(profile, workerTransport, lease, execution);
        if (execution.status === 'completed') {
          result.completed += 1;
        } else if (execution.status === 'blocked') {
          result.blocked += 1;
        } else {
          result.failed += 1;
        }
        await workerTransport.cleanup(lease);
        result.cleanup += 1;
        if (options.once) break;
      }
    } finally {
      await workerTransport.heartbeat({
        status: 'offline',
        healthStatus: 'offline',
        lifecycle: options.lifecycle,
      });
    }

    return result;
  } finally {
    processLock?.release();
    await bootstrap.cleanup?.();
  }
}

async function executeBootstrapLease(
  profile: WorkerRuntimeProfile,
  transport: WorkerTransport,
  lease: ClaimedLease,
): Promise<StandaloneWorkerResult> {
  const execution = await executeClaim(profile, transport, lease);
  await transport.sync(lease, execution);
  await maybeExecuteHostedSessionVerification(profile, transport, lease, execution);
  await transport.cleanup(lease);

  return {
    claimed: 1,
    completed: execution.status === 'completed' ? 1 : 0,
    blocked: execution.status === 'blocked' ? 1 : 0,
    failed: execution.status === 'failed' || execution.status === 'canceled' ? 1 : 0,
    cleanup: 1,
    denied: 0,
  };
}

function runnerPoolFromCapabilities(capabilities: Record<string, unknown>): string | undefined {
  const value = capabilities['runner_pool'] ?? capabilities['runnerPool'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function validateWorkerWorkspaceRoot(workspaceRoot: string): Promise<void> {
  const resolved = path.resolve(workspaceRoot);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(
      `Worker workspace root is not available: ${resolved}. Run vpd pair --worker or configure a valid worker workspace root before starting the worker.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Worker workspace root is not a directory: ${resolved}.`);
  }
  try {
    await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`Worker workspace root is not readable and writable: ${resolved}.`);
  }
}

async function executeClaim(
  profile: WorkerRuntimeProfile,
  transport: WorkerTransport,
  lease: ClaimedLease,
): Promise<HostedClaimExecutionResult> {
  if (!isHostedManagedExecutorProfile(profile)) {
    return { status: 'completed' };
  }
  return withGatewayLeaseProcessEnv(lease, () =>
    executeHostedWorkflowClaim(profile, transport, lease),
  );
}

async function loadWorkerRuntimeBootstrap(
  bootstrapPath?: string,
  registrationProfilePath?: string,
): Promise<WorkerRuntimeBootstrap> {
  if (bootstrapPath) {
    return loadSandboxBootstrap(bootstrapPath);
  }
  if (registrationProfilePath) {
    return {
      profile: await loadManagedExecutorRuntimeProfile(registrationProfilePath),
    };
  }

  return { profile: await loadWorkerRuntimeProfile() };
}

async function loadManagedExecutorRuntimeProfile(
  profilePath: string,
): Promise<WorkerRuntimeProfile> {
  const profile = await readManagedExecutorRegistrationProfile(profilePath);
  const credential = await credentialFromManagedExecutorProfile(profile);
  const missing: string[] = [];
  if (!profile.serverUrl) missing.push('server URL');
  if (!profile.workspaceId) missing.push('workspace id');
  if (!profile.executorId) missing.push('managed executor id');
  if (!credential) missing.push('managed executor credential');
  if (missing.length > 0) {
    throw new Error(`Managed executor registration profile is missing ${missing.join(', ')}.`);
  }

  const identity = await ensureManagedExecutorIdentity(
    profile.identityKeyPath ??
      managedExecutorIdentityPath(profile.workspaceId!, profile.executorId!),
  );
  const workspaceRoot = managedExecutorWorkspaceRoot(profile);
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const runnerPool =
    stringValue(profile.capabilities?.['runner_pool']) ??
    stringValue(profile.capabilities?.['runnerPool']) ??
    profile.runnerProfile;
  const capabilities = {
    ...(profile.capabilities ?? {}),
    ...(runnerPool ? { runner_pool: runnerPool } : {}),
    ...(profile.runnerPosture ? { runner_posture: profile.runnerPosture } : {}),
  };

  return {
    serverUrl: profile.serverUrl!.replace(/\/+$/, ''),
    serverId: profile.serverId,
    lifecycle: 'persistent',
    transport: workerTransportValue(profile.accessMode) ?? 'polling',
    workspaceId: profile.workspaceId!,
    managedExecutorId: profile.executorId!,
    credential: credential!,
    workspaceRoot,
    identityKeyPath: identity.path,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    capabilities,
  };
}

async function readManagedExecutorRegistrationProfile(
  profilePath: string,
): Promise<ManagedExecutorRegistrationProfile> {
  const resolved = resolveProfilePath(profilePath);
  const parsed = JSON.parse(await fs.readFile(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Managed executor registration profile is not a JSON object: ${resolved}`);
  }
  const record = parsed as Record<string, unknown>;
  const schema = stringValue(record['schema']);
  if (schema && schema !== 'viewport.managed_executor_registration/v1') {
    throw new Error(`Unsupported managed executor registration profile schema: ${schema}`);
  }
  const daemon = recordValue(record['daemon']);
  const worker = recordValue(daemon?.['worker']);

  return {
    serverUrl:
      stringValue(record['server_url']) ??
      stringValue(record['serverUrl']) ??
      stringValue(worker?.['serverUrl']) ??
      stringValue(worker?.['server_url']),
    serverId:
      stringValue(record['server_id']) ??
      stringValue(record['serverId']) ??
      stringValue(record['control_plane_id']) ??
      stringValue(worker?.['serverId']) ??
      stringValue(worker?.['server_id']) ??
      stringValue(worker?.['control_plane_id']),
    workspaceId:
      stringValue(record['workspace_id']) ??
      stringValue(record['workspaceId']) ??
      stringValue(worker?.['workspaceId']) ??
      stringValue(worker?.['workspace_id']),
    executorId:
      stringValue(record['managed_executor_id']) ??
      stringValue(record['executor_id']) ??
      stringValue(record['executorId']) ??
      stringValue(worker?.['managedExecutorId']) ??
      stringValue(worker?.['managed_executor_id']),
    credential: stringValue(record['credential']) ?? stringValue(worker?.['credential']),
    credentialFile:
      stringValue(record['credential_file']) ??
      stringValue(record['credentialFile']) ??
      stringValue(worker?.['credentialFile']) ??
      stringValue(worker?.['credential_file']),
    accessMode:
      stringValue(record['access_mode']) ??
      stringValue(record['accessMode']) ??
      stringValue(worker?.['accessMode']) ??
      stringValue(worker?.['access_mode']) ??
      stringValue(worker?.['transport']),
    runnerProfile:
      stringValue(record['runner_profile']) ??
      stringValue(record['runnerProfile']) ??
      stringValue(worker?.['runnerProfile']) ??
      stringValue(worker?.['runner_profile']),
    runnerPosture:
      recordValue(record['runner_posture']) ??
      recordValue(record['runnerPosture']) ??
      recordValue(worker?.['runnerPosture']) ??
      recordValue(worker?.['runner_posture']) ??
      undefined,
    workspaceRoot:
      stringValue(record['workspace_root']) ??
      stringValue(record['workspaceRoot']) ??
      stringValue(record['workdir']) ??
      stringValue(worker?.['workspaceRoot']) ??
      stringValue(worker?.['workspace_root']) ??
      stringValue(worker?.['workdir']),
    identityKeyPath:
      stringValue(record['identity_key_path']) ??
      stringValue(record['identityKeyPath']) ??
      stringValue(worker?.['identityKeyPath']) ??
      stringValue(worker?.['identity_key_path']),
    capabilities:
      recordValue(record['capabilities']) ?? recordValue(worker?.['capabilities']) ?? undefined,
  };
}

async function credentialFromManagedExecutorProfile(
  profile: ManagedExecutorRegistrationProfile,
): Promise<string | undefined> {
  if (profile.credentialFile) {
    const value = (await fs.readFile(resolveProfilePath(profile.credentialFile), 'utf8')).trim();
    if (!value) {
      throw new Error(
        `Managed executor credential file is empty: ${resolveProfilePath(profile.credentialFile)}`,
      );
    }
    return value;
  }
  return (
    profile.credential ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ??
    process.env['VPD_MANAGED_EXECUTOR_TOKEN']
  );
}

function managedExecutorWorkspaceRoot(profile: ManagedExecutorRegistrationProfile): string {
  if (profile.workspaceRoot) return path.resolve(resolveProfilePath(profile.workspaceRoot));
  const safeName = `${safeFilename(profile.workspaceId ?? 'workspace')}-${safeFilename(
    profile.executorId ?? 'executor',
  )}`;
  return path.join(os.homedir(), '.viewport', 'managed-executors', 'workspaces', safeName);
}

function managedExecutorIdentityPath(workspaceId: string, executorId: string): string {
  const safeName = `${safeFilename(workspaceId)}-${safeFilename(executorId)}.json`;
  return path.join(os.homedir(), '.viewport', 'managed-executors', 'identities', safeName);
}

async function ensureManagedExecutorIdentity(
  identityPath: string,
): Promise<WorkerIdentityFile & { path: string }> {
  const resolved = resolveProfilePath(identityPath);
  try {
    const parsed = JSON.parse(await fs.readFile(resolved, 'utf8')) as Partial<WorkerIdentityFile>;
    if (
      parsed.algorithm?.toLowerCase() === 'ed25519' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string'
    ) {
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        publicKeyFingerprint:
          normalizeWorkerFingerprint(parsed.publicKeyFingerprint) ??
          publicKeyFingerprint(parsed.publicKey),
        path: resolved,
      };
    }
  } catch {
    // Generate below.
  }

  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const record: WorkerIdentityFile = {
    version: 1,
    algorithm: 'ed25519',
    publicKey,
    privateKey,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fs.writeFile(resolved, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(resolved, 0o600);
  return { ...record, path: resolved };
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function normalizeWorkerFingerprint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function resolveProfilePath(profilePath: string): string {
  if (profilePath === '~') return os.homedir();
  if (profilePath.startsWith('~/')) return path.join(os.homedir(), profilePath.slice(2));
  return path.resolve(profilePath);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'default';
}

async function loadWorkerRuntimeProfile(): Promise<WorkerRuntimeProfile> {
  const manager = new ConfigManager();
  await manager.load();
  const worker = manager.getDaemonConfig()?.worker;
  const missing: string[] = [];
  if (!worker?.serverUrl) missing.push('server URL');
  if (!worker?.workspaceRoot) missing.push('workspace root');
  if (!worker?.publicKeyFingerprint) missing.push('worker identity');
  if (missing.length > 0) {
    throw new Error(`Worker profile is not configured: missing ${missing.join(', ')}.`);
  }
  const pairing = await readWorkerPairingRecord(worker!.stateDir);
  const integrity = workerProfileIntegrity(worker, pairing);
  if (!integrity.ok) {
    throw new Error(
      `Worker profile does not match the approved pairing record: ${integrity.mismatches.join(
        ', ',
      )}. Run \`vpd worker reset\`, then pair this worker again.`,
    );
  }
  return {
    serverUrl: worker!.serverUrl!,
    serverId: worker!.serverId,
    lifecycle: worker!.lifecycle ?? 'persistent',
    transport: worker!.transport ?? 'polling',
    inbound: recordValue(worker!.inbound),
    workspaceId: worker!.workspaceId ?? process.env['VIEWPORT_WORKSPACE_ID'],
    managedExecutorId: worker!.managedExecutorId ?? process.env['VIEWPORT_MANAGED_EXECUTOR_ID'],
    credential:
      worker!.credential ??
      process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ??
      process.env['VPD_MANAGED_EXECUTOR_TOKEN'],
    relayWsBaseUrl:
      process.env['VIEWPORT_RELAY_WS_BASE_URL'] ?? process.env['VPD_RELAY_WS_BASE_URL'],
    workspaceRoot: worker!.workspaceRoot!,
    identityKeyPath: worker!.identityKeyPath!,
    publicKeyFingerprint: worker!.publicKeyFingerprint!,
    capabilities: worker!.capabilities ?? {},
  };
}

async function loadSandboxBootstrap(bootstrapPath: string): Promise<WorkerRuntimeBootstrap> {
  const raw = JSON.parse(await fs.readFile(bootstrapPath, 'utf8')) as Record<string, unknown>;
  if (raw['schema'] !== 'viewport.sandbox_bootstrap/v1') {
    throw new Error('Sandbox bootstrap file must use schema viewport.sandbox_bootstrap/v1.');
  }
  const workspaceRoot = requiredString(
    raw['workspace_root'] ?? raw['workspaceRoot'],
    'workspace_root',
  );
  const identity = recordValue(raw['identity']);
  const identityFile = await materializeBootstrapIdentity(identity, workspaceRoot);
  const profile: WorkerRuntimeProfile = {
    serverUrl: requiredString(raw['server_url'] ?? raw['serverUrl'], 'server_url'),
    serverId: stringValue(raw['server_id'] ?? raw['serverId']),
    lifecycle: 'ephemeral',
    transport: workerTransportValue(raw['transport']) ?? 'polling',
    workspaceId: requiredString(raw['workspace_id'] ?? raw['workspaceId'], 'workspace_id'),
    managedExecutorId: requiredString(raw['executor_id'] ?? raw['executorId'], 'executor_id'),
    credential: requiredString(raw['credential'], 'credential'),
    relayWsBaseUrl: stringValue(
      raw['relay_ws_base_url'] ?? raw['relayWsBaseUrl'] ?? raw['relay_url'] ?? raw['relayUrl'],
    ),
    workspaceRoot,
    identityKeyPath: identityFile.path,
    publicKeyFingerprint: identityFile.publicKeyFingerprint,
    capabilities: recordValue(raw['capabilities']) ?? {},
  };

  return {
    profile,
    lease: claimedLeaseFromBootstrap(recordValue(raw['lease'])),
    cleanup: async () => {
      if (identityFile.ephemeral) {
        await fs.rm(identityFile.path, { force: true });
      }
    },
  };
}

function claimedLeaseFromBootstrap(
  rawLease: Record<string, unknown> | undefined,
): ClaimedLease | undefined {
  if (!rawLease) return undefined;
  const id = requiredString(
    rawLease['id'] ?? rawLease['lease_id'] ?? rawLease['leaseId'],
    'lease.id',
  );
  return {
    id,
    agentSessionId: stringValue(rawLease['agent_session_id'] ?? rawLease['agentSessionId']),
    runId: stringValue(rawLease['workflow_run_id'] ?? rawLease['run_id'] ?? rawLease['runId']),
    runtimeRunId: stringValue(rawLease['runtime_run_id'] ?? rawLease['runtimeRunId']),
    leaseToken: stringValue(rawLease['lease_token'] ?? rawLease['leaseToken']),
    assignmentClaimToken: stringValue(
      rawLease['assignment_claim_token'] ?? rawLease['assignmentClaimToken'],
    ),
    sessionVerificationContract: sessionVerificationContractValue(
      rawLease['session_verification_contract'] ?? rawLease['sessionVerificationContract'],
    ),
    gateway: gatewayLeaseValue(rawLease['gateway'] ?? rawLease['gatewayLease']),
    yamlSnapshot: stringValue(rawLease['yaml_snapshot'] ?? rawLease['yamlSnapshot']),
    sourceRef: stringValue(rawLease['source_ref'] ?? rawLease['sourceRef']),
    directoryPath: stringValue(rawLease['directory_path'] ?? rawLease['directoryPath']),
    inputSnapshot: recordValue(rawLease['input_snapshot'] ?? rawLease['inputSnapshot']) as
      | Record<string, WorkflowInputValue>
      | undefined,
    resourceManifest: recordValue(rawLease['resource_manifest'] ?? rawLease['resourceManifest']),
    workflowAuthorityContract: recordValue(
      rawLease['workflow_authority_contract'] ?? rawLease['workflowAuthorityContract'],
    ),
    executionProfileSnapshot: recordValue(
      rawLease['execution_profile_snapshot'] ?? rawLease['executionProfileSnapshot'],
    ),
    workflowSnapshot: recordValue(rawLease['workflow_snapshot'] ?? rawLease['workflowSnapshot']),
    runtimeTargetId: runtimeContextTargetIdValue(rawLease),
    dataCapturePolicy: dataCapturePolicyValue(
      rawLease['data_capture_policy'] ?? rawLease['dataCapturePolicy'],
    ),
  };
}

function gatewayLeaseValue(value: unknown): GatewayLease | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const provider = stringValue(record['provider']);
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'gemini') {
    return undefined;
  }
  const gatewayBaseUrl = stringValue(
    record['gateway_base_url'] ??
      record['gatewayBaseUrl'] ??
      record['base_url'] ??
      record['baseUrl'],
  );
  const virtualKey = recordValue(record['virtual_key'] ?? record['virtualKey']);
  const token = stringValue(virtualKey?.['token']);
  const modelAllow = arrayOfStrings(record['model_allow'] ?? record['modelAllow']);
  if (!gatewayBaseUrl || !token || modelAllow.length === 0) {
    return undefined;
  }

  return {
    gatewayBaseUrl: gatewayBaseUrl.replace(/\/+$/, ''),
    provider,
    modelAllow,
    virtualKey: { token },
  };
}

async function withGatewayLeaseProcessEnv<T>(
  lease: ClaimedLease,
  callback: () => Promise<T>,
): Promise<T> {
  const env = gatewayLeaseEnv(lease.gateway);
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function gatewayLeaseEnv(gateway: GatewayLease | undefined): Record<string, string> {
  if (!gateway) return {};
  const model = gateway.modelAllow[0] ?? '';
  const base = gateway.gatewayBaseUrl.replace(/\/+$/, '');
  const common = {
    VIEWPORT_GATEWAY_BASE_URL: base,
    VIEWPORT_LLM_PROVIDER: gateway.provider,
    VIEWPORT_LLM_MODEL: model,
    VIEWPORT_LLM_VIRTUAL_KEY: gateway.virtualKey.token,
  };

  if (gateway.provider === 'openai') {
    return {
      ...common,
      CODEX_API_KEY: gateway.virtualKey.token,
      OPENAI_API_KEY: gateway.virtualKey.token,
      OPENAI_BASE_URL: `${base}/openai/v1`,
    };
  }

  if (gateway.provider === 'anthropic') {
    return {
      ...common,
      ANTHROPIC_API_KEY: gateway.virtualKey.token,
      ANTHROPIC_BASE_URL: `${base}/anthropic`,
      // Claude Code defaults to its own preferred model; the lease's model
      // allow-list is the governed truth, so make its head the agent default.
      ...(model ? { ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model } : {}),
    };
  }

  return {
    ...common,
    GEMINI_API_KEY: gateway.virtualKey.token,
    GEMINI_BASE_URL: `${base}/gemini/v1beta/openai`,
    GOOGLE_GENERATIVE_AI_API_KEY: gateway.virtualKey.token,
  };
}

function gatewayLeaseCredentialEnv(gateway: GatewayLease | undefined): Record<string, string> {
  if (!gateway) return {};
  const env = gatewayLeaseEnv(gateway);
  const aliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    aliases[envNameForCredentialRef(name)] = value;
  }

  return aliases;
}

async function materializeBootstrapIdentity(
  identity: Record<string, unknown> | undefined,
  workspaceRoot: string,
): Promise<{ path: string; publicKeyFingerprint: string; ephemeral: boolean }> {
  if (!identity) {
    throw new Error('Sandbox bootstrap file is missing identity.');
  }
  const publicKey = requiredString(
    identity['public_key'] ?? identity['publicKey'],
    'identity.public_key',
  );
  const privateKey = requiredString(
    identity['private_key'] ?? identity['privateKey'],
    'identity.private_key',
  );
  const publicKeyFingerprint = requiredString(
    identity['public_key_fingerprint'] ?? identity['publicKeyFingerprint'],
    'identity.public_key_fingerprint',
  );
  const dir = path.join(workspaceRoot, '.viewport', 'bootstrap');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `identity-${crypto.randomUUID()}.json`);
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ publicKey, privateKey, publicKeyFingerprint })}\n`,
    { mode: 0o600 },
  );
  return { path: filePath, publicKeyFingerprint, ephemeral: true };
}

function workerTransportValue(value: unknown): WorkerTransportMode | undefined {
  return value === 'polling' || value === 'relay' || value === 'inbound' ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) {
    throw new Error(`Sandbox bootstrap file is missing ${label}.`);
  }
  return result;
}

function validateInboundWorkerGate(profile: WorkerRuntimeProfile): never {
  const enabled =
    profile.inbound?.enabled === true || process.env['VPD_WORKER_INBOUND_EXPERIMENTAL'] === '1';
  if (!enabled) {
    throw new Error(
      'Inbound worker transport is disabled by default. Enable VPD_WORKER_INBOUND_EXPERIMENTAL=1 only with signed inbound proof, replay protection, and control-plane claim verification.',
    );
  }
  const missing: string[] = [];
  if (profile.inbound?.signedRequests !== true) missing.push('signed inbound requests');
  if (profile.inbound?.replayProtection !== true) missing.push('replay protection');
  if (profile.inbound?.controlPlaneClaimVerify !== true) {
    missing.push('control-plane claim verification');
  }
  if (missing.length > 0) {
    throw new Error(`Inbound worker transport is gated: missing ${missing.join(', ')}.`);
  }
  throw new Error(
    'Inbound worker transport listener is not implemented yet; do not enable inbound without the signed listener proof.',
  );
}

async function claimLeaseHttp(
  profile: WorkerRuntimeProfile,
  body: Record<string, unknown>,
  dispatcher?: HostedManagedExecutorDispatcher,
): Promise<ClaimedLease | null> {
  const leaseSeconds = positiveInteger(body['leaseSeconds']) ?? DEFAULT_HOSTED_LEASE_SECONDS;
  const response = isHostedManagedExecutorProfile(profile)
    ? await hostedManagedExecutorFetch(
        profile,
        'POST',
        'claim',
        {
          credential: profile.credential,
          lease_seconds: leaseSeconds,
        },
        undefined,
        undefined,
        [],
        dispatcher,
      )
    : await workerFetch(profile, 'workers/claim', body);
  if (response.status === 204) return null;
  const parsed = (await response.json()) as Record<string, unknown>;
  const data =
    parsed['data'] && typeof parsed['data'] === 'object'
      ? (parsed['data'] as Record<string, unknown>)
      : parsed;
  const rawLease =
    data['run_lease'] && typeof data['run_lease'] === 'object'
      ? (data['run_lease'] as Record<string, unknown>)
      : data['lease'] && typeof data['lease'] === 'object'
        ? (data['lease'] as Record<string, unknown>)
        : data;
  const id = stringValue(rawLease['id'] ?? rawLease['lease_id']);
  if (!id) {
    throw new Error('Worker claim response did not include a lease id.');
  }
  return {
    id,
    agentSessionId: stringValue(
      data['agent_session_id'] ??
        data['agentSessionId'] ??
        rawLease['agent_session_id'] ??
        rawLease['agentSessionId'],
    ),
    runId: stringValue(
      data['id'] ?? rawLease['workflow_run_id'] ?? rawLease['run_id'] ?? rawLease['runId'],
    ),
    runtimeRunId: stringValue(data['runtime_run_id'] ?? rawLease['runtime_run_id']),
    leaseToken: stringValue(rawLease['lease_token'] ?? rawLease['leaseToken']),
    assignmentClaimToken: stringValue(data['assignment_claim_token']),
    sessionVerificationContract: sessionVerificationContractValue(
      data['session_verification_contract'] ??
        data['sessionVerificationContract'] ??
        rawLease['session_verification_contract'] ??
        rawLease['sessionVerificationContract'],
    ),
    yamlSnapshot: stringValue(data['yaml_snapshot'] ?? rawLease['yaml_snapshot']),
    sourceRef: stringValue(data['source_ref'] ?? rawLease['source_ref']),
    directoryPath: stringValue(data['directory_path'] ?? rawLease['directory_path']),
    inputSnapshot: recordValue(data['input_snapshot'] ?? rawLease['input_snapshot']) as
      | Record<string, WorkflowInputValue>
      | undefined,
    resourceManifest: recordValue(data['resource_manifest'] ?? rawLease['resource_manifest']),
    workflowAuthorityContract: recordValue(
      data['workflow_authority_contract'] ?? rawLease['workflow_authority_contract'],
    ),
    executionProfileSnapshot: recordValue(
      data['execution_profile_snapshot'] ?? rawLease['execution_profile_snapshot'],
    ),
    workflowSnapshot: recordValue(data['workflow_snapshot'] ?? rawLease['workflow_snapshot']),
    runtimeTargetId: runtimeContextTargetIdValue(data, rawLease),
    dataCapturePolicy: dataCapturePolicyValue(
      data['data_capture_policy'] ?? rawLease['data_capture_policy'],
    ),
  };
}

async function heartbeatHttp(
  profile: WorkerRuntimeProfile,
  options: {
    status: 'online' | 'offline';
    healthStatus: 'idle' | 'offline';
    lifecycle: WorkerLifecycle;
    transport: WorkerTransportMode;
  },
  dispatcher?: HostedManagedExecutorDispatcher,
): Promise<void> {
  const capabilityPayload = managedExecutorCapabilities(profile.capabilities);
  if (isHostedManagedExecutorProfile(profile)) {
    await hostedManagedExecutorFetch(
      profile,
      'POST',
      'heartbeat',
      {
        credential: profile.credential,
        status: options.status,
        health_status: options.healthStatus,
        access_mode: options.transport,
        runner_mode: options.lifecycle === 'ephemeral' ? 'viewport_managed' : 'self_hosted',
        runner_provider: options.lifecycle === 'ephemeral' ? 'viewport_cloud' : 'local',
        context_execution_mode:
          options.lifecycle === 'ephemeral'
            ? 'viewport_managed'
            : 'customer_managed_context_worker',
        credential_mode: options.lifecycle === 'ephemeral' ? 'run_scoped_grant' : 'runner_local',
        runner_profile:
          stringValue(capabilityPayload['runner_pool']) ??
          stringValue(capabilityPayload['runnerPool']) ??
          null,
        runner_posture: {
          transport: { mode: options.transport },
          execution: {
            kind: options.lifecycle === 'ephemeral' ? 'ephemeral-worker' : 'persistent-worker',
          },
        },
        capabilities: capabilityPayload,
      },
      undefined,
      undefined,
      [],
      dispatcher,
    );
    return;
  }
  await workerRequest(profile, 'workers/heartbeat', {
    status: options.status,
    health_status: options.healthStatus,
    lifecycle: options.lifecycle,
    transport: options.transport,
    workspace_root: profile.workspaceRoot,
    public_key_fingerprint: profile.publicKeyFingerprint,
    capabilities: profile.capabilities,
  });
}

async function syncLeaseHttp(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
  execution: HostedClaimExecutionResult,
  dispatcher?: HostedManagedExecutorDispatcher,
): Promise<void> {
  const status = execution.status;
  if (isHostedManagedExecutorProfile(profile)) {
    if (!lease.runId) {
      throw new Error('Hosted managed executor sync requires a workflow run id.');
    }
    const runPayload = execution.run
      ? workflowRunToSyncPayload(execution.run, {
          enforceDataCapturePolicy: true,
          includeApprovalDecisions: false,
        })
      : undefined;
    const failure = execution.failure ?? hostedWorkerExecutionUnavailableFailure();
    await hostedManagedExecutorFetch(
      profile,
      'PATCH',
      `workflow-runs/${encodeURIComponent(lease.runId)}/sync`,
      {
        ...(runPayload ?? {}),
        credential: profile.credential,
        runtime_run_id:
          typeof runPayload?.['runtime_run_id'] === 'string'
            ? runPayload['runtime_run_id']
            : `vpd-worker-${lease.runId}`,
        status,
        completed_at:
          status === 'blocked'
            ? null
            : typeof runPayload?.['completed_at'] === 'string'
              ? runPayload['completed_at']
              : new Date().toISOString(),
        ...(status === 'failed'
          ? {
              error_summary: failure.summary,
              failure: {
                schema: 'viewport.workflow_failure/v1',
                error_code: failure.errorCode,
                failure_class: failure.failureClass,
                summary: failure.summary,
                next_check: failure.nextCheck,
                retry_safe: failure.retrySafe,
                lease_released: true,
                details: {
                  worker_runtime: 'standalone',
                  hosted_managed_executor: true,
                },
              },
            }
          : {}),
        events: [
          ...((Array.isArray(runPayload?.['events'])
            ? (runPayload['events'] as unknown[])
            : []) as unknown[]),
          {
            runtime_event_id: `vpd-worker-${lease.runId}-${status}`,
            type: status === 'completed' ? 'run-completed' : 'run-failed',
            severity: status === 'completed' ? 'info' : 'error',
            message: `vpd worker marked run ${status}`,
          },
        ],
      },
      lease.assignmentClaimToken,
      lease.leaseToken,
      [],
      dispatcher,
    );
    return;
  }
  await workerRequest(profile, `workers/leases/${encodeURIComponent(lease.id)}/sync`, {
    lease_id: lease.id,
    run_id: lease.runId ?? null,
    status,
    event_type: 'phase8_fixture',
    runtime_event_id: `phase8-${lease.id}-${status}`,
  });
}

async function executeHostedWorkflowClaim(
  profile: WorkerRuntimeProfile,
  transport: WorkerTransport,
  lease: ClaimedLease,
): Promise<HostedClaimExecutionResult> {
  if (!lease.leaseToken) {
    return {
      status: 'failed',
      failure: hostedWorkerMissingLeaseTokenFailure(),
    };
  }

  if (!lease.yamlSnapshot) {
    return {
      status: 'failed',
      failure: hostedWorkerExecutionUnavailableFailure(),
    };
  }

  try {
    const daemon = await createStandaloneWorkerDaemon();
    const existing = await existingHostedRuntimeRun(lease);
    if (existing) {
      if (existing.status === 'blocked') {
        const body = await transport.pollRuntimeCommands(lease);
        const runtimeSecretEnv = await runtimeSecretEnvForHostedRun(profile, lease, transport);
        const applied = await daemon.workflowRunner.applyRuntimeCommandBody(existing.id, body, {
          runtimeSecretEnv,
        });
        if (applied > 0) {
          const completed = await waitForWorkflowRun(daemon, existing.id);
          return {
            status: normalizeWorkflowStatus(completed.status),
            run: completed,
            daemon,
            ...(completed.status === 'failed' || completed.status === 'canceled'
              ? { failure: workflowRunFailure(completed) }
              : {}),
          };
        }
      }
      return {
        status: normalizeWorkflowStatus(existing.status),
        run: existing,
        daemon,
        ...(existing.status === 'failed' || existing.status === 'canceled'
          ? { failure: workflowRunFailure(existing) }
          : {}),
      };
    }
    const directoryPath = path.resolve(lease.directoryPath ?? profile.workspaceRoot);
    await fs.mkdir(directoryPath, { recursive: true });
    const directory = await daemon.directoryManager.register(directoryPath);
    const runtimeSecretEnv = await runtimeSecretEnvForHostedRun(profile, lease, transport);
    const run = await daemon.workflowRunner.startRun({
      workflowYaml: lease.yamlSnapshot,
      workflowSourceRef:
        lease.sourceRef ?? `viewport://managed-executor/${lease.runId ?? lease.id}`,
      directoryId: directory.id,
      inputs: hostedWorkflowInputs(profile, lease),
      resourceId: profile.workspaceId,
      runtimeTargetId: hostedRuntimeContextTargetId(profile, lease),
      platformRunId: lease.runId,
      agentSessionId: lease.agentSessionId,
      resourceManifest: lease.resourceManifest as never,
      workflowAuthorityContract: lease.workflowAuthorityContract,
      dataCapturePolicy: lease.dataCapturePolicy,
      runtimeSecretEnv,
      initiation: 'cli',
    });
    const completed = await waitForWorkflowRun(daemon, run.id);
    return {
      status: normalizeWorkflowStatus(completed.status),
      run: completed,
      daemon,
      ...(completed.status === 'failed' || completed.status === 'canceled'
        ? { failure: workflowRunFailure(completed) }
        : {}),
    };
  } catch (error) {
    return {
      status: 'failed',
      failure: {
        errorCode: 'RUNNER_WORKFLOW_EXECUTION_FAILED',
        failureClass: 'internal_error',
        summary: error instanceof Error ? error.message : 'Standalone worker execution failed.',
        nextCheck: 'Inspect worker logs and workflow execution receipts.',
        retrySafe: false,
      },
    };
  }
}

async function materializeHostedRunCredentials(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
  dispatcher?: HostedManagedExecutorDispatcher,
): Promise<Record<string, string>> {
  if (!lease.runId) {
    throw new Error(
      'Hosted managed executor credential materialization requires a workflow run id.',
    );
  }
  if (!lease.assignmentClaimToken) {
    throw new Error('Hosted managed executor credential materialization requires a claim token.');
  }

  const runtimeSecretEnv: Record<string, string> = {};
  const handles = credentialHandlesFromLease(lease);
  for (const handle of handles) {
    const response = await hostedManagedExecutorFetch(
      profile,
      'POST',
      `workflow-runs/${encodeURIComponent(lease.runId)}/credential-material`,
      {
        credential: profile.credential,
        handle,
        ...repositoryForCredentialHandle(lease, handle),
      },
      lease.assignmentClaimToken,
      lease.leaseToken,
      [],
      dispatcher,
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    const data =
      parsed['data'] && typeof parsed['data'] === 'object'
        ? (parsed['data'] as Record<string, unknown>)
        : parsed;
    const secret = stringValue(data['secret']);
    if (secret) {
      runtimeSecretEnv[envNameForCredentialRef(handle)] = secret;
    }
  }

  return runtimeSecretEnv;
}

async function runtimeSecretEnvForHostedRun(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
  transport?: WorkerTransport,
): Promise<Record<string, string>> {
  const dispatcher =
    transport instanceof RelayWorkerTransport
      ? (request: HostedManagedExecutorRequest) =>
          transport.dispatchHostedManagedExecutorRequest(request)
      : undefined;
  return {
    ...(await materializeHostedRunCredentials(profile, lease, dispatcher)),
    ...gatewayLeaseCredentialEnv(lease.gateway),
    ...gatewayLeaseEnv(lease.gateway),
  };
}

function credentialHandlesFromLease(lease: ClaimedLease): string[] {
  const workflow = yamlSnapshotDocument(lease);
  const handles = new Set<string>();
  for (const handle of [
    ...workflowNodeCredentialRefs(isRecord(workflow) ? workflow['nodes'] : undefined),
    ...topLevelCredentialRefs(isRecord(workflow) ? workflow['credentials'] : undefined),
    ...profileCredentialRefs(lease.executionProfileSnapshot),
    ...profileCredentialRefs(lease.workflowSnapshot),
    ...providerActionCredentialRefs(lease.workflowAuthorityContract),
  ]) {
    handles.add(handle);
  }
  return [...handles].sort();
}

function repositoryForCredentialHandle(
  lease: ClaimedLease,
  handle: string,
): { repository: string } | Record<string, never> {
  const workflow = yamlSnapshotDocument(lease);
  const nodes = isRecord(workflow) ? workflow['nodes'] : undefined;
  if (!isRecord(nodes)) return {};
  for (const node of Object.values(nodes)) {
    if (!isRecord(node)) continue;
    const withValue = isRecord(node['with']) ? node['with'] : {};
    const credentialRef =
      stringValue(withValue['credential_ref']) ??
      stringValue(withValue['credentialRef']) ??
      stringValue(node['credential_ref']) ??
      stringValue(node['credentialRef']);
    if (credentialRef !== handle) continue;
    const repository = renderLeaseTemplate(repositoryTemplateForNode(node, withValue), lease);
    if (repository) return { repository };
  }
  return {};
}

function workflowNodeCredentialRefs(nodes: unknown): string[] {
  if (!isRecord(nodes)) return [];
  return Object.values(nodes).flatMap((node) => {
    if (!isRecord(node)) return [];
    const type = stringValue(node['type']);
    if (type !== 'action' && type !== 'checkout' && type !== 'git_publish') return [];
    const withValue = isRecord(node['with']) ? node['with'] : {};
    const credentialRef =
      stringValue(withValue['credential_ref']) ??
      stringValue(withValue['credentialRef']) ??
      stringValue(node['credential_ref']) ??
      stringValue(node['credentialRef']);
    return credentialRef ? [credentialRef] : [];
  });
}

function topLevelCredentialRefs(credentials: unknown): string[] {
  if (!isRecord(credentials)) return [];
  const refs: string[] = [];
  for (const value of Object.values(credentials)) {
    refs.push(...credentialEntriesFrom(value));
  }
  return refs;
}

function profileCredentialRefs(snapshot: unknown): string[] {
  const credentials = pathValue(asRecord(snapshot), ['credentials']);
  if (!isRecord(credentials)) return [];
  const refs: string[] = [];
  for (const value of Object.values(credentials)) {
    refs.push(...credentialEntriesFrom(value));
  }
  return refs;
}

function credentialEntriesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim() !== '') return [entry.trim()];
    if (!isRecord(entry)) return [];
    const handle =
      stringValue(entry['handle']) ??
      stringValue(entry['ref']) ??
      stringValue(entry['credential_ref']) ??
      stringValue(entry['credentialRef']);
    return handle ? [handle] : [];
  });
}

function providerActionCredentialRefs(contract: unknown): string[] {
  const entries = pathValue(asRecord(contract), ['credentials', 'provider_actions']);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim() !== '') return [entry.trim()];
    if (!isRecord(entry)) return [];
    const value =
      stringValue(entry['handle']) ??
      stringValue(entry['ref']) ??
      stringValue(entry['credential_ref']);
    return value ? [value] : [];
  });
}

function repositoryTemplateForNode(
  node: Record<string, unknown>,
  withValue: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(withValue['repository']) ??
    stringValue(withValue['repo']) ??
    stringValue(node['repository']) ??
    stringValue(node['repo'])
  );
}

function renderLeaseTemplate(value: string | undefined, lease: ClaimedLease): string | null {
  if (!value) return null;
  const inputs = isRecord(lease.inputSnapshot) ? lease.inputSnapshot : {};
  const rendered = value.replace(
    /\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g,
    (_match: string, key: string) => {
      const input = inputs[key];
      return typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean'
        ? String(input)
        : '';
    },
  );
  const trimmed = rendered.trim();
  return trimmed === '' || trimmed.includes('{{') ? null : trimmed;
}

function yamlSnapshotDocument(lease: ClaimedLease): unknown {
  if (!lease.yamlSnapshot) return null;
  try {
    return YAML.parse(lease.yamlSnapshot);
  } catch {
    return null;
  }
}

async function existingHostedRuntimeRun(lease: ClaimedLease): Promise<WorkflowRunRecord | null> {
  if (!lease.runtimeRunId) return null;
  const existing = await new WorkflowRunStore().get(lease.runtimeRunId);
  if (!existing) return null;
  if (lease.runId && existing.platformRunId !== lease.runId) return null;
  return existing;
}

async function resumeBlockedHostedExecution(
  profile: WorkerRuntimeProfile,
  transport: WorkerTransport,
  lease: ClaimedLease,
  execution: HostedClaimExecutionResult,
): Promise<HostedClaimExecutionResult> {
  if (!execution.daemon || !execution.run || execution.status !== 'blocked') {
    return execution;
  }

  const daemon = execution.daemon;
  const workflowRunId = execution.run.id;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const body = await transport.pollRuntimeCommands(lease);
    if (!hasRuntimeCommands(body)) {
      if (shouldRetryHostedCommandPoll(body)) {
        continue;
      }
      return execution;
    }
    const runtimeSecretEnv = await runtimeSecretEnvForHostedRun(profile, lease);
    const applied = await daemon.workflowRunner.applyRuntimeCommandBody(workflowRunId, body, {
      runtimeSecretEnv,
    });
    if (applied > 0) {
      const completed = await waitForWorkflowRun(daemon, workflowRunId);
      if (completed.status === 'blocked') {
        const blockedExecution: HostedClaimExecutionResult = {
          status: 'blocked',
          run: completed,
          daemon,
        };
        await transport.sync(lease, blockedExecution);
        execution = blockedExecution;
        continue;
      }
      return {
        status: normalizeWorkflowStatus(completed.status),
        run: completed,
        daemon,
        ...(completed.status === 'failed' || completed.status === 'canceled'
          ? { failure: workflowRunFailure(completed) }
          : {}),
      };
    }
    await sleep(2_000);
  }

  return execution;
}

async function maybeExecuteHostedSessionVerification(
  profile: WorkerRuntimeProfile,
  transport: WorkerTransport,
  lease: ClaimedLease,
  execution: HostedClaimExecutionResult,
): Promise<void> {
  if (!isHostedManagedExecutorProfile(profile)) return;
  if (execution.status !== 'completed' || !execution.run) return;

  const contract = await executableHostedSessionVerificationContract(transport, lease);
  if (!contract || !verificationRunnerMayExecute(contract)) return;

  const agentSessionId = verificationAgentSessionId(contract);
  if (!agentSessionId) return;

  const commands = verificationCommands(contract);
  if (commands.length === 0) return;

  const runDirectoryPath =
    execution.run.directoryPath ?? lease.directoryPath ?? profile.workspaceRoot;
  const defaultCommandDirectory = verificationDefaultCommandDirectory(execution.run);
  const commandResults: Array<Record<string, unknown>> = [];
  const artifactRefs: string[] = [];

  for (const command of commands) {
    const name = verificationCommandName(command, commandResults.length + 1);
    const commandText = verificationCommandText(command);
    let result: ShellCommandResult;
    let executionError: string | undefined;
    try {
      const cwd = verificationCommandCwd(runDirectoryPath, command, defaultCommandDirectory);
      result = await runShellCommand(commandText, '', cwd);
    } catch (error) {
      executionError = errorMessage(error);
      result = { exitCode: 1, stdout: '', stderr: '' };
    }

    const stdoutDigest = sha256Text(result.stdout);
    const stderrDigest = sha256Text(result.stderr);
    const status = result.exitCode === 0 ? 'passed' : 'failed';
    artifactRefs.push(`verification:${name}:stdout:${stdoutDigest}`);
    if (result.stderr.trim() !== '') {
      artifactRefs.push(`verification:${name}:stderr:${stderrDigest}`);
    }

    commandResults.push({
      schema: 'viewport.verification_command_result/v1',
      name,
      status,
      required: command.required !== false,
      exit_code: result.exitCode,
      command_sha256: sha256Text(commandText),
      stdout_sha256: stdoutDigest,
      stderr_sha256: stderrDigest,
      stdout_bytes: Buffer.byteLength(result.stdout, 'utf8'),
      stderr_bytes: Buffer.byteLength(result.stderr, 'utf8'),
      working_directory:
        verificationCommandWorkingDirectory(command) ??
        verificationDisplayWorkingDirectory(runDirectoryPath, defaultCommandDirectory),
      raw_output_included: false,
      ...(executionError ? { error: executionError } : {}),
    });
  }

  const requiredFailures = commandResults.filter(
    (result) => result['required'] !== false && result['status'] !== 'passed',
  );
  const passedCount = commandResults.filter((result) => result['status'] === 'passed').length;
  const status = requiredFailures.length > 0 ? 'failed' : 'passed';
  const summary =
    status === 'passed'
      ? `${passedCount}/${commandResults.length} verification commands passed.`
      : `${requiredFailures.length} required verification command(s) failed.`;

  await postHostedSessionVerificationAttempt(profile, transport, lease, contract, agentSessionId, {
    status,
    attempt_kind: 'verification',
    summary,
    artifact_refs: artifactRefs.slice(0, 50),
    verification_pack: {
      schema: 'viewport.verification_pack_result/v1',
      source_schema: contract.schema ?? null,
      agent_session_id: agentSessionId,
      workflow_run_id: lease.runId,
      policy_hash: typeof contract['policy_hash'] === 'string' ? contract['policy_hash'] : null,
      command_results: commandResults,
      required_artifacts: verificationRequiredArtifacts(contract),
      raw_command_output_included: false,
      agent_self_assessment_used: false,
    },
    repair_recommendation:
      status === 'passed'
        ? { action: 'none' }
        : {
            action: 'ask_human',
            failed_commands: requiredFailures.map((result) => result['name']),
          },
  });
}

async function executableHostedSessionVerificationContract(
  transport: WorkerTransport,
  lease: ClaimedLease,
): Promise<ManagedSessionVerificationContract | null> {
  const contract = lease.sessionVerificationContract;
  if (contract && verificationRunnerMayExecute(contract)) return contract;
  if (!leaseMayHaveSessionVerification(lease)) return contract ?? null;

  const refreshed = await transport.pollRuntimeCommands(lease);
  return sessionVerificationContractFromBody(refreshed) ?? contract ?? null;
}

function leaseMayHaveSessionVerification(lease: ClaimedLease): boolean {
  const policyPin = recordValue(lease.workflowSnapshot?.['product20_policy_pin']);
  return Boolean(
    lease.agentSessionId ||
    stringValue(policyPin?.['agent_session_id']) ||
    lease.sessionVerificationContract,
  );
}

function sessionVerificationContractFromBody(
  body: unknown,
): ManagedSessionVerificationContract | null {
  const record = recordValue(body);
  const data = recordValue(record?.['data']);
  return (
    sessionVerificationContractValue(
      data?.['session_verification_contract'] ??
        data?.['sessionVerificationContract'] ??
        record?.['session_verification_contract'] ??
        record?.['sessionVerificationContract'],
    ) ?? null
  );
}

function sessionVerificationContractValue(
  value: unknown,
): ManagedSessionVerificationContract | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  return record as ManagedSessionVerificationContract;
}

function verificationRunnerMayExecute(contract: ManagedSessionVerificationContract): boolean {
  const access = contract.access_model ?? contract.accessModel ?? {};
  return access.runner_may_execute_commands === true || access.runnerMayExecuteCommands === true;
}

function verificationAgentSessionId(contract: ManagedSessionVerificationContract): string | null {
  return contract.agent_session_id ?? contract.agentSessionId ?? null;
}

function verificationCommands(
  contract: ManagedSessionVerificationContract,
): ManagedSessionVerificationCommand[] {
  return (contract.commands ?? []).filter(
    (command): command is ManagedSessionVerificationCommand =>
      verificationCommandText(command) !== '',
  );
}

function verificationCommandName(
  command: ManagedSessionVerificationCommand,
  index: number,
): string {
  return command.name?.trim() || `verification-${index}`;
}

function verificationCommandText(command: ManagedSessionVerificationCommand): string {
  return command.command?.trim() ?? '';
}

function verificationCommandWorkingDirectory(
  command: ManagedSessionVerificationCommand,
): string | null {
  return command.working_directory?.trim() || command.workingDirectory?.trim() || null;
}

function verificationCommandCwd(
  runDirectoryPath: string,
  command: ManagedSessionVerificationCommand,
  defaultDirectoryPath?: string,
): string {
  const workingDirectory = verificationCommandWorkingDirectory(command);
  const root = path.resolve(runDirectoryPath);
  const resolved = workingDirectory
    ? path.resolve(root, workingDirectory)
    : path.resolve(defaultDirectoryPath ?? root);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Verification command working_directory must stay inside the run directory.');
  }
  return resolved;
}

function verificationDefaultCommandDirectory(run: WorkflowRunRecord): string {
  const root = path.resolve(run.directoryPath);
  for (const node of Object.values(run.nodes ?? {})) {
    if (node.type !== 'checkout') continue;
    const candidate = typeof node.outputs?.['path'] === 'string' ? node.outputs['path'] : null;
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return resolved;
    }
  }

  return root;
}

function verificationDisplayWorkingDirectory(
  runDirectoryPath: string,
  directoryPath: string,
): string {
  const root = path.resolve(runDirectoryPath);
  const resolved = path.resolve(directoryPath);
  const relative = path.relative(root, resolved);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '.';
  return relative;
}

function verificationRequiredArtifacts(contract: ManagedSessionVerificationContract): string[] {
  return contract.required_artifacts ?? contract.requiredArtifacts ?? [];
}

interface ShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runShellCommand(
  command: string,
  stdin: string,
  cwd = process.cwd(),
): Promise<ShellCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-lc', command], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(stdin);
  });
}

function sha256Text(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postHostedSessionVerificationAttempt(
  profile: WorkerRuntimeProfile,
  transport: WorkerTransport,
  lease: ClaimedLease,
  contract: ManagedSessionVerificationContract,
  agentSessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!lease.runId) {
    throw new Error('Hosted session verification requires a workflow run id.');
  }
  const runLeaseToken = lease.assignmentClaimToken ?? lease.leaseToken;
  if (!runLeaseToken) {
    throw new Error('Hosted session verification requires a run lease token.');
  }
  const suffix =
    hostedVerificationRuntimePathSuffix(profile, contract, agentSessionId) ??
    `workflow-runs/${encodeURIComponent(lease.runId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/verification-attempts`;
  const dispatcher =
    transport instanceof RelayWorkerTransport
      ? (request: HostedManagedExecutorRequest) =>
          transport.dispatchHostedManagedExecutorRequest(request)
      : undefined;

  await hostedManagedExecutorFetch(
    profile,
    'POST',
    suffix,
    {
      credential: profile.credential,
      ...payload,
    },
    undefined,
    runLeaseToken,
    [],
    dispatcher,
  );
}

function hostedVerificationRuntimePathSuffix(
  profile: WorkerRuntimeProfile,
  contract: ManagedSessionVerificationContract,
  agentSessionId: string,
): string | null {
  const runtimeTool = contract.runtime_tool ?? contract.runtimeTool ?? {};
  const endpoint = runtimeTool.runtime_endpoint ?? runtimeTool.runtimeEndpoint;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;

  const normalized = endpoint.trim();
  const prefix = `/api/runtime/workspaces/${encodeURIComponent(
    profile.workspaceId ?? '',
  )}/managed-executors/${encodeURIComponent(profile.managedExecutorId ?? '')}/`;
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length);
  }

  const fallback = `/workflow-runs/`;
  const index = normalized.indexOf(fallback);
  if (index >= 0 && normalized.includes(`/agent-sessions/${encodeURIComponent(agentSessionId)}/`)) {
    return normalized.slice(index + 1);
  }

  return null;
}

async function fetchHostedAssignmentHttp(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
  dispatcher?: HostedManagedExecutorDispatcher,
): Promise<HostedAssignmentCommandPoll> {
  if (!lease.runId) {
    throw new Error('Hosted managed executor assignment polling requires a workflow run id.');
  }
  const response = await hostedManagedExecutorFetch(
    profile,
    'GET',
    `workflow-runs/${encodeURIComponent(lease.runId)}`,
    {},
    lease.assignmentClaimToken,
    lease.leaseToken,
    [429],
    dispatcher,
  );
  if (response.status === 429) {
    await sleep(retryAfterMs(response));
    return { runtime_commands: [], _viewport_worker_retry: true };
  }
  return (await response.json()) as HostedAssignmentCommandPoll;
}

function hasRuntimeCommands(body: HostedAssignmentCommandPoll): boolean {
  return Array.isArray(body.runtime_commands) && body.runtime_commands.length > 0;
}

function shouldRetryHostedCommandPoll(body: HostedAssignmentCommandPoll): boolean {
  return body._viewport_worker_retry === true;
}

async function createStandaloneWorkerDaemon(): Promise<Daemon> {
  const daemon = new Daemon();
  await daemon.initialize();
  const registry = await loadAgents(daemon);
  daemon.setModelProvider(() => registry.fetchAllModels());
  daemon.setTrackerFactory((trackerConfig, sessionId) => new GitTracker(trackerConfig, sessionId));
  daemon.resumePendingWorkflowRuns();
  return daemon;
}

async function waitForWorkflowRun(daemon: Daemon, runId: string): Promise<WorkflowRunRecord> {
  const deadline = Date.now() + 10 * 60_000;
  let last: WorkflowRunRecord | null = null;
  const store = new WorkflowRunStore();
  while (Date.now() < deadline) {
    last = (await store.get(runId)) ?? (await daemon.workflowRunner.getRun(runId));
    if (last && ['completed', 'failed', 'blocked', 'canceled'].includes(last.status)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Workflow run ${runId} did not reach a terminal or blocked state.`);
}

function normalizeWorkflowStatus(
  status: WorkflowRunStatus,
): Extract<WorkflowRunStatus, 'completed' | 'failed' | 'blocked' | 'canceled'> {
  return ['completed', 'failed', 'blocked', 'canceled'].includes(status)
    ? (status as Extract<WorkflowRunStatus, 'completed' | 'failed' | 'blocked' | 'canceled'>)
    : 'failed';
}

function hostedWorkerExecutionUnavailableFailure(): HostedWorkerFailure {
  return {
    errorCode: 'RUNNER_EXECUTION_ENGINE_UNAVAILABLE',
    failureClass: 'internal_error',
    summary:
      'Standalone hosted worker claimed the run but no workflow execution engine is wired yet.',
    nextCheck: 'Wire the in-process workflow executor before enabling hosted worker completion.',
    retrySafe: false,
  };
}

function hostedWorkerMissingLeaseTokenFailure(): HostedWorkerFailure {
  return {
    errorCode: 'RUNNER_LEASE_TOKEN_MISSING',
    failureClass: 'authorization_denied',
    summary: 'Hosted worker claim did not include a server-issued run lease token.',
    nextCheck: 'Re-pair the worker or upgrade the control plane to return run_lease.lease_token.',
    retrySafe: false,
  };
}

function workflowRunFailure(run: WorkflowRunRecord): HostedWorkerFailure {
  return {
    errorCode: run.status === 'canceled' ? 'RUNNER_WORKFLOW_CANCELED' : 'RUNNER_WORKFLOW_FAILED',
    failureClass: run.status === 'canceled' ? 'canceled' : 'workflow_error',
    summary: run.error ?? `Workflow run ended with status ${run.status}.`,
    nextCheck: 'Inspect workflow node receipts and worker logs.',
    retrySafe: false,
  };
}

async function cleanupLeaseHttp(profile: WorkerRuntimeProfile, lease: ClaimedLease): Promise<void> {
  if (isHostedManagedExecutorProfile(profile)) {
    return;
  }
  await workerRequest(profile, `workers/leases/${encodeURIComponent(lease.id)}/cleanup`, {
    lease_id: lease.id,
    run_id: lease.runId ?? null,
    status: 'cleanup_completed',
    runtime_event_id: `phase8-${lease.id}-cleanup`,
  });
}

async function workerRequest(
  profile: WorkerRuntimeProfile,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  await workerFetch(profile, path, body);
}

async function workerFetch(
  profile: WorkerRuntimeProfile,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const requestPath = `/api/runtime/${path}`;
  const serialized = JSON.stringify(body);
  const signed = await signWorkerRequest(profile, 'POST', requestPath, serialized);
  const response = await transportFetch(`${profile.serverUrl.replace(/\/+$/, '')}${requestPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Viewport-Worker-Fingerprint': profile.publicKeyFingerprint,
      'X-Viewport-Worker-Timestamp': signed.timestamp,
      'X-Viewport-Worker-Nonce': signed.nonce,
      'X-Viewport-Worker-Body-SHA256': signed.bodySha256,
      'X-Viewport-Worker-Signature': signed.signature,
      ...(signed.serverId ? { 'X-Viewport-Server-Id': signed.serverId } : {}),
    },
    body: serialized,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Worker runtime request ${path} failed with HTTP ${response.status}: ${text}`);
  }
  return response;
}

function isHostedManagedExecutorProfile(profile: WorkerRuntimeProfile): boolean {
  return Boolean(profile.workspaceId && profile.managedExecutorId && profile.credential);
}

function managedExecutorCapabilities(
  capabilities: Record<string, unknown>,
): Record<string, unknown> {
  const { schema: _schema, ...normalized } = capabilities;
  const agents = capabilities['agents'];
  if (!Array.isArray(agents)) return normalized;
  const objectAgents = agents
    .filter((agent) => typeof agent === 'object' && agent !== null && !Array.isArray(agent))
    .map((agent) => {
      const record = agent as Record<string, unknown>;
      const id = stringValue(record['id']);
      return id ? [id, record] : null;
    })
    .filter((entry): entry is [string, Record<string, unknown>] => entry !== null);
  if (objectAgents.length === 0) return normalized;

  return {
    ...normalized,
    agents: Object.fromEntries(objectAgents),
  };
}

async function hostedManagedExecutorFetch(
  profile: WorkerRuntimeProfile,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
  assignmentClaimToken?: string,
  runLeaseToken?: string,
  allowedStatuses: number[] = [],
  dispatcher?: HostedManagedExecutorDispatcher,
): Promise<Response> {
  if (!profile.workspaceId || !profile.managedExecutorId || !profile.credential) {
    throw new Error(
      'Hosted managed executor profile is missing workspace, executor, or credential.',
    );
  }
  const requestPath = `/api/runtime/workspaces/${encodeURIComponent(
    profile.workspaceId,
  )}/managed-executors/${encodeURIComponent(profile.managedExecutorId)}/${path}`;
  const serialized = method === 'GET' ? '' : JSON.stringify(body);
  const url = `${profile.serverUrl.replace(/\/+$/, '')}${requestPath}`;
  let lastResponse: Response | null = null;
  const maxAttempts = hostedManagedExecutorMaxAttempts();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const signed = await signWorkerRequest(profile, method, requestPath, serialized);
    const headers = {
      Authorization: `Bearer ${profile.credential}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(runLeaseToken
        ? { 'X-Viewport-Run-Lease': runLeaseToken }
        : assignmentClaimToken
          ? { 'X-Viewport-Assignment-Claim': assignmentClaimToken }
          : {}),
      'X-Viewport-Worker-Fingerprint': profile.publicKeyFingerprint,
      'X-Viewport-Worker-Timestamp': signed.timestamp,
      'X-Viewport-Worker-Nonce': signed.nonce,
      'X-Viewport-Worker-Body-SHA256': signed.bodySha256,
      'X-Viewport-Worker-Signature': signed.signature,
      ...(signed.serverId ? { 'X-Viewport-Server-Id': signed.serverId } : {}),
    };
    const request = {
      method,
      path,
      requestPath,
      url,
      serialized,
      headers,
    };
    const response = dispatcher
      ? await dispatcher(request)
      : await transportFetch(url, {
          method,
          headers,
          ...(method === 'GET' ? {} : { body: serialized }),
        });
    if (response.ok || allowedStatuses.includes(response.status)) {
      return response;
    }
    lastResponse = response;
    if (!isHostedManagedExecutorTransientStatus(response.status) || attempt === maxAttempts) {
      break;
    }
    await response.text().catch(() => '');
    await sleep(hostedManagedExecutorRetryDelayMs(response, attempt));
  }

  const response = lastResponse;
  if (!response) {
    throw new Error(`Hosted managed executor request ${path} failed before dispatch.`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Hosted managed executor request ${path} failed with HTTP ${response.status}: ${text}`,
    );
  }
  return response;
}

function hostedManagedExecutorMaxAttempts(): number {
  return 4;
}

function isHostedManagedExecutorTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function hostedManagedExecutorRetryDelayMs(response: Response, attempt: number): number {
  if (response.status === 429) {
    return retryAfterMs(response);
  }
  return Math.min(500 * 2 ** (attempt - 1), 5_000);
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get('retry-after');
  const seconds = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, 30_000);
  }
  return 5_000;
}

function relayWorkerConnectionTimeoutMs(): number {
  return positiveIntegerFromEnv('VIEWPORT_RELAY_WORKER_CONNECT_TIMEOUT_MS') ?? 10_000;
}

function relayWorkerRequestTimeoutMs(): number {
  return positiveIntegerFromEnv('VIEWPORT_RELAY_WORKER_REQUEST_TIMEOUT_MS') ?? 60_000;
}

function positiveIntegerFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function relayWsBaseUrlFromServerUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = parsed.hostname.startsWith('api.')
    ? `relay.${parsed.hostname.slice(4)}`
    : parsed.hostname;
  return `${protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ''}/ws`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function pathValue(value: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function dataCapturePolicyValue(value: unknown): WorkflowDataCapturePolicy | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const transcripts = record['transcripts'];
  const logs = record['logs'];
  const artifacts = record['artifacts'];
  if (
    (transcripts === 'none' || transcripts === 'excerpt') &&
    (logs === 'metadata' || logs === 'content') &&
    (artifacts === 'metadata' || artifacts === 'local_reference')
  ) {
    return { transcripts, logs, artifacts };
  }
  return undefined;
}

async function signWorkerRequest(
  profile: WorkerRuntimeProfile,
  method: string,
  requestPath: string,
  body: string,
): Promise<{
  timestamp: string;
  nonce: string;
  bodySha256: string;
  signature: string;
  serverId?: string;
}> {
  const identity = JSON.parse(
    await fs.readFile(profile.identityKeyPath, 'utf8'),
  ) as WorkerIdentityFile;
  if (identity.publicKeyFingerprint !== profile.publicKeyFingerprint) {
    throw new Error('Worker identity fingerprint does not match worker profile.');
  }
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = [
    method.toUpperCase(),
    requestPath,
    bodySha256,
    nonce,
    timestamp,
    ...(profile.serverId ? [profile.serverId] : []),
  ].join('\n');
  const signature = crypto
    .sign(null, Buffer.from(canonical), identity.privateKey)
    .toString('base64');
  return { timestamp, nonce, bodySha256, signature, serverId: profile.serverId };
}
