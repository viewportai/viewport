import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigManager } from '../core/config.js';
import { Daemon } from '../core/daemon.js';
import { loadAgents } from '../startup-agents.js';
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
import type { WorkerLifecycle, WorkerTransport } from './worker-profile.js';

export interface StandaloneWorkerOptions {
  lifecycle: WorkerLifecycle;
  transport: WorkerTransport;
  once: boolean;
  leaseToken?: string;
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
  transport: WorkerTransport;
  inbound?: {
    enabled?: boolean;
    signedRequests?: boolean;
    replayProtection?: boolean;
    controlPlaneClaimVerify?: boolean;
  };
  workspaceId?: string;
  managedExecutorId?: string;
  credential?: string;
  workspaceRoot: string;
  identityKeyPath: string;
  publicKeyFingerprint: string;
  capabilities: Record<string, unknown>;
}

interface WorkerIdentityFile {
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
}

interface ClaimedLease {
  id: string;
  runId?: string;
  runtimeRunId?: string;
  leaseToken?: string;
  assignmentClaimToken?: string;
  yamlSnapshot?: string;
  sourceRef?: string;
  directoryPath?: string;
  inputSnapshot?: Record<string, WorkflowInputValue>;
  resourceManifest?: Record<string, unknown>;
  workflowAuthorityContract?: Record<string, unknown>;
  runtimeTargetId?: string;
  dataCapturePolicy?: WorkflowDataCapturePolicy;
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

export async function runStandaloneWorker(
  options: StandaloneWorkerOptions,
): Promise<StandaloneWorkerResult> {
  const profile = await loadWorkerRuntimeProfile();
  await validateWorkerWorkspaceRoot(profile.workspaceRoot);
  const transport = options.transport ?? profile.transport;
  if (transport === 'inbound') {
    validateInboundWorkerGate(profile);
  }
  if (transport === 'relay') {
    throw new Error('Relay worker transport is not supported by the standalone runtime yet.');
  }

  let lastHeartbeatAt = Date.now();
  await heartbeat(profile, {
    status: 'online',
    healthStatus: 'idle',
    lifecycle: options.lifecycle,
    transport,
  });

  if (options.leaseToken) {
    const lease: ClaimedLease = { id: options.leaseToken, leaseToken: options.leaseToken };
    await syncLease(profile, lease, { status: 'completed' });
    await cleanupLease(profile, lease);
    return { claimed: 1, completed: 1, blocked: 0, failed: 0, cleanup: 1, denied: 0 };
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
      const lease = await claimLease(profile, {
        lifecycle: options.lifecycle,
        transport,
      });
      if (!lease) {
        if (options.once || options.lifecycle !== 'persistent') break;
        const now = Date.now();
        if (now - lastHeartbeatAt > 30_000) {
          await heartbeat(profile, {
            status: 'online',
            healthStatus: 'idle',
            lifecycle: options.lifecycle,
            transport,
          });
          lastHeartbeatAt = now;
        }
        await sleepWithAbort(options.pollIntervalMs ?? 5_000, options.abortSignal);
        continue;
      }
      result.claimed += 1;
      let execution = await executeClaim(profile, lease);
      if (
        isHostedManagedExecutorProfile(profile) &&
        execution.status === 'blocked' &&
        execution.run
      ) {
        await syncLease(profile, lease, execution);
        execution = await resumeBlockedHostedExecution(profile, lease, execution);
        if (execution.status !== 'blocked') {
          await syncLease(profile, lease, execution);
        }
      } else {
        await syncLease(profile, lease, execution);
      }
      if (execution.status === 'completed') {
        result.completed += 1;
      } else if (execution.status === 'blocked') {
        result.blocked += 1;
      } else {
        result.failed += 1;
      }
      await cleanupLease(profile, lease);
      result.cleanup += 1;
      if (options.once) break;
    }
  } finally {
    await heartbeat(profile, {
      status: 'offline',
      healthStatus: 'offline',
      lifecycle: options.lifecycle,
      transport,
    });
  }

  return result;
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
  lease: ClaimedLease,
): Promise<HostedClaimExecutionResult> {
  if (!isHostedManagedExecutorProfile(profile)) {
    return { status: 'completed' };
  }
  return executeHostedWorkflowClaim(profile, lease);
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
    workspaceRoot: worker!.workspaceRoot!,
    identityKeyPath: worker!.identityKeyPath!,
    publicKeyFingerprint: worker!.publicKeyFingerprint!,
    capabilities: worker!.capabilities ?? {},
  };
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

async function claimLease(
  profile: WorkerRuntimeProfile,
  body: Record<string, unknown>,
): Promise<ClaimedLease | null> {
  const response = isHostedManagedExecutorProfile(profile)
    ? await hostedManagedExecutorFetch(profile, 'POST', 'claim', {
        credential: profile.credential,
        lease_seconds: 300,
      })
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
    runId: stringValue(
      data['id'] ?? rawLease['workflow_run_id'] ?? rawLease['run_id'] ?? rawLease['runId'],
    ),
    runtimeRunId: stringValue(data['runtime_run_id'] ?? rawLease['runtime_run_id']),
    leaseToken: stringValue(rawLease['lease_token'] ?? rawLease['leaseToken']),
    assignmentClaimToken: stringValue(data['assignment_claim_token']),
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
    runtimeTargetId: stringValue(data['runtime_target_id'] ?? rawLease['runtime_target_id']),
    dataCapturePolicy: dataCapturePolicyValue(
      data['data_capture_policy'] ?? rawLease['data_capture_policy'],
    ),
  };
}

async function heartbeat(
  profile: WorkerRuntimeProfile,
  options: {
    status: 'online' | 'offline';
    healthStatus: 'idle' | 'offline';
    lifecycle: WorkerLifecycle;
    transport: WorkerTransport;
  },
): Promise<void> {
  const capabilityPayload = managedExecutorCapabilities(profile.capabilities);
  if (isHostedManagedExecutorProfile(profile)) {
    await hostedManagedExecutorFetch(profile, 'POST', 'heartbeat', {
      credential: profile.credential,
      status: options.status,
      health_status: options.healthStatus,
      access_mode: options.transport,
      runner_mode: options.lifecycle === 'ephemeral' ? 'viewport_managed' : 'self_hosted',
      runner_provider: options.lifecycle === 'ephemeral' ? 'viewport_cloud' : 'local',
      context_execution_mode:
        options.lifecycle === 'ephemeral' ? 'viewport_managed' : 'customer_managed_context_worker',
      credential_mode: options.lifecycle === 'ephemeral' ? 'run_scoped_grant' : 'runner_local',
      runner_posture: {
        transport: { mode: options.transport },
        execution: {
          kind: options.lifecycle === 'ephemeral' ? 'ephemeral-worker' : 'persistent-worker',
        },
      },
      capabilities: capabilityPayload,
    });
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

async function syncLease(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
  execution: HostedClaimExecutionResult,
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
  lease: ClaimedLease,
): Promise<HostedClaimExecutionResult> {
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
    const run = await daemon.workflowRunner.startRun({
      workflowYaml: lease.yamlSnapshot,
      workflowSourceRef:
        lease.sourceRef ?? `viewport://managed-executor/${lease.runId ?? lease.id}`,
      directoryId: directory.id,
      inputs: lease.inputSnapshot,
      resourceId: profile.workspaceId,
      runtimeTargetId: lease.runtimeTargetId ?? profile.managedExecutorId,
      platformRunId: lease.runId,
      resourceManifest: lease.resourceManifest as never,
      workflowAuthorityContract: lease.workflowAuthorityContract,
      dataCapturePolicy: lease.dataCapturePolicy,
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

async function existingHostedRuntimeRun(lease: ClaimedLease): Promise<WorkflowRunRecord | null> {
  if (!lease.runtimeRunId) return null;
  const existing = await new WorkflowRunStore().get(lease.runtimeRunId);
  if (!existing) return null;
  if (lease.runId && existing.platformRunId !== lease.runId) return null;
  return existing;
}

async function resumeBlockedHostedExecution(
  profile: WorkerRuntimeProfile,
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
    const body = await fetchHostedAssignment(profile, lease);
    const applied = await daemon.workflowRunner.applyRuntimeCommandBody(workflowRunId, body);
    if (applied > 0) {
      const completed = await waitForWorkflowRun(daemon, workflowRunId);
      if (completed.status === 'blocked') {
        const blockedExecution: HostedClaimExecutionResult = {
          status: 'blocked',
          run: completed,
          daemon,
        };
        await syncLease(profile, lease, blockedExecution);
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

async function fetchHostedAssignment(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
): Promise<unknown> {
  if (!lease.runId) {
    throw new Error('Hosted managed executor assignment polling requires a workflow run id.');
  }
  const response = await hostedManagedExecutorFetch(
    profile,
    'GET',
    `workflow-runs/${encodeURIComponent(lease.runId)}`,
    {},
    lease.assignmentClaimToken,
    [429],
  );
  if (response.status === 429) {
    await sleep(retryAfterMs(response));
    return { runtime_commands: [] };
  }
  return response.json();
}

async function createStandaloneWorkerDaemon(): Promise<Daemon> {
  const daemon = new Daemon();
  await daemon.initialize();
  const registry = await loadAgents(daemon);
  daemon.setModelProvider(() => registry.fetchAllModels());
  daemon.setTrackerFactory((trackerConfig, sessionId) => new GitTracker(trackerConfig, sessionId));
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

function workflowRunFailure(run: WorkflowRunRecord): HostedWorkerFailure {
  return {
    errorCode: run.status === 'canceled' ? 'RUNNER_WORKFLOW_CANCELED' : 'RUNNER_WORKFLOW_FAILED',
    failureClass: run.status === 'canceled' ? 'canceled' : 'workflow_error',
    summary: run.error ?? `Workflow run ended with status ${run.status}.`,
    nextCheck: 'Inspect workflow node receipts and worker logs.',
    retrySafe: false,
  };
}

async function cleanupLease(profile: WorkerRuntimeProfile, lease: ClaimedLease): Promise<void> {
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
  const agents = capabilities['agents'];
  if (!Array.isArray(agents)) return capabilities;
  return {
    ...capabilities,
    agents: Object.fromEntries(
      agents
        .filter((agent) => typeof agent === 'object' && agent !== null && !Array.isArray(agent))
        .map((agent) => {
          const record = agent as Record<string, unknown>;
          const id = stringValue(record['id']);
          return id ? [id, record] : null;
        })
        .filter((entry): entry is [string, Record<string, unknown>] => entry !== null),
    ),
  };
}

async function hostedManagedExecutorFetch(
  profile: WorkerRuntimeProfile,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
  assignmentClaimToken?: string,
  allowedStatuses: number[] = [],
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
    const response = await transportFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${profile.credential}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(assignmentClaimToken ? { 'X-Viewport-Assignment-Claim': assignmentClaimToken } : {}),
        'X-Viewport-Worker-Fingerprint': profile.publicKeyFingerprint,
        'X-Viewport-Worker-Timestamp': signed.timestamp,
        'X-Viewport-Worker-Nonce': signed.nonce,
        'X-Viewport-Worker-Body-SHA256': signed.bodySha256,
        'X-Viewport-Worker-Signature': signed.signature,
        ...(signed.serverId ? { 'X-Viewport-Server-Id': signed.serverId } : {}),
      },
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
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
