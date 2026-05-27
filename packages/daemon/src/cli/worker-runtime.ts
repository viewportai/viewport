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
  cleanup: number;
  denied: number;
}

interface WorkerRuntimeProfile {
  serverUrl: string;
  lifecycle: WorkerLifecycle;
  transport: WorkerTransport;
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

  await workerRequest(profile, 'workers/heartbeat', {
    status: 'online',
    health_status: 'idle',
    lifecycle: options.lifecycle,
    transport,
    workspace_root: profile.workspaceRoot,
    public_key_fingerprint: profile.publicKeyFingerprint,
    capabilities: profile.capabilities,
  });

  if (options.leaseToken) {
    const lease: ClaimedLease = { id: options.leaseToken, leaseToken: options.leaseToken };
    await syncLease(profile, lease, 'completed');
    await cleanupLease(profile, lease);
    return { claimed: 1, completed: 1, cleanup: 1, denied: 0 };
  }

  const result: StandaloneWorkerResult = { claimed: 0, completed: 0, cleanup: 0, denied: 0 };
  do {
    const lease = await claimLease(profile, {
      lifecycle: options.lifecycle,
      transport,
    });
    if (!lease) break;
    result.claimed += 1;
    await syncLease(profile, lease, 'completed');
    result.completed += 1;
    await cleanupLease(profile, lease);
    result.cleanup += 1;
  } while (!options.once);

  await workerRequest(profile, 'workers/heartbeat', {
    status: 'offline',
    health_status: 'offline',
    lifecycle: options.lifecycle,
    transport,
    workspace_root: profile.workspaceRoot,
    public_key_fingerprint: profile.publicKeyFingerprint,
    capabilities: profile.capabilities,
  });

  return result;
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
  const response = await workerFetch(profile, 'workers/claim', body);
  if (response.status === 204) return null;
  const parsed = (await response.json()) as Record<string, unknown>;
  const rawLease =
    parsed['lease'] && typeof parsed['lease'] === 'object'
      ? (parsed['lease'] as Record<string, unknown>)
      : parsed;
  const id = stringValue(rawLease['id'] ?? rawLease['lease_id']);
  if (!id) {
    throw new Error('Worker claim response did not include a lease id.');
  }
  return {
    id,
    runId: stringValue(rawLease['run_id'] ?? rawLease['runId']),
    leaseToken: stringValue(rawLease['lease_token'] ?? rawLease['leaseToken']),
  };
}

async function syncLease(
  profile: WorkerRuntimeProfile,
  lease: ClaimedLease,
  status: 'completed' | 'failed',
): Promise<void> {
  await workerRequest(profile, `workers/leases/${encodeURIComponent(lease.id)}/sync`, {
    lease_id: lease.id,
    run_id: lease.runId ?? null,
    status,
    event_type: 'phase8_fixture',
    runtime_event_id: `phase8-${lease.id}-${status}`,
  });
}

async function cleanupLease(profile: WorkerRuntimeProfile, lease: ClaimedLease): Promise<void> {
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
