import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { ConfigManager } from '../core/config.js';
import { transportFetch } from './network.js';
import type { WorkerLifecycle, WorkerTransport } from './worker-profile.js';

export interface StandaloneWorkerOptions {
  lifecycle: WorkerLifecycle;
  transport: WorkerTransport;
  once: boolean;
  leaseToken?: string;
}

export interface StandaloneWorkerResult {
  claimed: number;
  completed: number;
  failed: number;
  cleanup: number;
  denied: number;
}

interface WorkerRuntimeProfile {
  serverUrl: string;
  lifecycle: WorkerLifecycle;
  transport: WorkerTransport;
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
  leaseToken?: string;
  assignmentClaimToken?: string;
}

export async function runStandaloneWorker(
  options: StandaloneWorkerOptions,
): Promise<StandaloneWorkerResult> {
  const profile = await loadWorkerRuntimeProfile();
  const transport = options.transport ?? profile.transport;
  if (transport === 'inbound') {
    throw new Error('Inbound worker transport is disabled until signed inbound proof lands.');
  }
  if (transport === 'relay') {
    throw new Error('Relay worker transport is not supported by the standalone runtime yet.');
  }

  await heartbeat(profile, {
    status: 'online',
    healthStatus: 'idle',
    lifecycle: options.lifecycle,
    transport,
  });

  if (options.leaseToken) {
    const lease: ClaimedLease = { id: options.leaseToken, leaseToken: options.leaseToken };
    await syncLease(profile, lease, 'completed');
    await cleanupLease(profile, lease);
    return { claimed: 1, completed: 1, failed: 0, cleanup: 1, denied: 0 };
  }

  const result: StandaloneWorkerResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    cleanup: 0,
    denied: 0,
  };
  do {
    const lease = await claimLease(profile, {
      lifecycle: options.lifecycle,
      transport,
    });
    if (!lease) break;
    result.claimed += 1;
    const terminalStatus = terminalStatusForClaim(profile);
    await syncLease(profile, lease, terminalStatus);
    if (terminalStatus === 'completed') {
      result.completed += 1;
    } else {
      result.failed += 1;
    }
    await cleanupLease(profile, lease);
    result.cleanup += 1;
  } while (!options.once);

  await heartbeat(profile, {
    status: 'offline',
    healthStatus: 'offline',
    lifecycle: options.lifecycle,
    transport,
  });

  return result;
}

function terminalStatusForClaim(profile: WorkerRuntimeProfile): 'completed' | 'failed' {
  return isHostedManagedExecutorProfile(profile) ? 'failed' : 'completed';
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
    lifecycle: worker!.lifecycle ?? 'persistent',
    transport: worker!.transport ?? 'polling',
    workspaceId: worker!.workspaceId ?? process.env['VIEWPORT_WORKSPACE_ID'],
    managedExecutorId:
      worker!.managedExecutorId ?? process.env['VIEWPORT_MANAGED_EXECUTOR_ID'],
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
    leaseToken: stringValue(rawLease['lease_token'] ?? rawLease['leaseToken']),
    assignmentClaimToken: stringValue(data['assignment_claim_token']),
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
  status: 'completed' | 'failed',
): Promise<void> {
  if (isHostedManagedExecutorProfile(profile)) {
    if (!lease.runId) {
      throw new Error('Hosted managed executor sync requires a workflow run id.');
    }
    await hostedManagedExecutorFetch(
      profile,
      'PATCH',
      `workflow-runs/${encodeURIComponent(lease.runId)}/sync`,
      {
        credential: profile.credential,
        runtime_run_id: `vpd-worker-${lease.runId}`,
        status,
        completed_at: new Date().toISOString(),
        ...(status === 'failed'
          ? {
              error_summary:
                'Standalone hosted worker claimed the run but no workflow execution engine is wired yet.',
              failure: {
                schema: 'viewport.workflow_failure/v1',
                error_code: 'RUNNER_EXECUTION_ENGINE_UNAVAILABLE',
                failure_class: 'internal_error',
                summary:
                  'Standalone hosted worker claimed the run but no workflow execution engine is wired yet.',
                next_check:
                  'Wire the in-process workflow executor before enabling hosted worker completion.',
                retry_safe: false,
                lease_released: true,
                details: {
                  worker_runtime: 'standalone',
                  hosted_managed_executor: true,
                },
              },
            }
          : {}),
        events: [
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
  const response = await transportFetch(
    `${profile.serverUrl.replace(/\/+$/, '')}${requestPath}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Viewport-Worker-Fingerprint': profile.publicKeyFingerprint,
        'X-Viewport-Worker-Timestamp': signed.timestamp,
        'X-Viewport-Worker-Nonce': signed.nonce,
        'X-Viewport-Worker-Body-SHA256': signed.bodySha256,
        'X-Viewport-Worker-Signature': signed.signature,
      },
      body: serialized,
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Worker runtime request ${path} failed with HTTP ${response.status}: ${text}`);
  }
  return response;
}

function isHostedManagedExecutorProfile(profile: WorkerRuntimeProfile): boolean {
  return Boolean(profile.workspaceId && profile.managedExecutorId && profile.credential);
}

function managedExecutorCapabilities(capabilities: Record<string, unknown>): Record<string, unknown> {
  const agents = capabilities['agents'];
  if (!Array.isArray(agents)) return capabilities;
  return {
    ...capabilities,
    agents: agents.map((agent) => {
      if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) return agent;
      const record = agent as Record<string, unknown>;
      return {
        id: record['id'],
        available: record['available'],
        tier: record['tier'],
      };
    }),
  };
}

async function hostedManagedExecutorFetch(
  profile: WorkerRuntimeProfile,
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
  assignmentClaimToken?: string,
): Promise<Response> {
  if (!profile.workspaceId || !profile.managedExecutorId || !profile.credential) {
    throw new Error('Hosted managed executor profile is missing workspace, executor, or credential.');
  }
  const requestPath = `/api/runtime/workspaces/${encodeURIComponent(
    profile.workspaceId,
  )}/managed-executors/${encodeURIComponent(profile.managedExecutorId)}/${path}`;
  const serialized = JSON.stringify(body);
  const signed = await signWorkerRequest(profile, method, requestPath, serialized);
  const response = await transportFetch(
    `${profile.serverUrl.replace(/\/+$/, '')}${requestPath}`,
    {
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
      },
      body: serialized,
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Hosted managed executor request ${path} failed with HTTP ${response.status}: ${text}`,
    );
  }
  return response;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
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
}> {
  const identity = JSON.parse(await fs.readFile(profile.identityKeyPath, 'utf8')) as WorkerIdentityFile;
  if (identity.publicKeyFingerprint !== profile.publicKeyFingerprint) {
    throw new Error('Worker identity fingerprint does not match worker profile.');
  }
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = [method.toUpperCase(), requestPath, bodySha256, nonce, timestamp].join('\n');
  const signature = crypto.sign(null, Buffer.from(canonical), identity.privateKey).toString('base64');
  return { timestamp, nonce, bodySha256, signature };
}
