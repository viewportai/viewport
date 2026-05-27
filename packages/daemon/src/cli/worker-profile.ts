import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BUILT_IN_AGENTS } from '../agents/built-in.js';
import { AgentRegistry } from '../core/agent-registry.js';
import { ConfigManager, configDir } from '../core/config.js';
import type { ViewportConfig } from '../core/config.js';
import { getFlag, hasFlag } from './args.js';
import type { PairingPollApprovedData, PairingServerTransportConfig } from './lifecycle-pair-server.js';
import { resolvePairingServerTransport } from './lifecycle-pair-server.js';

export type WorkerLifecycle = 'persistent' | 'ephemeral';
export type WorkerTransport = 'polling' | 'relay' | 'inbound';

export interface WorkerCapabilityAgent {
  id: string;
  displayName?: string;
  tier?: 'sdk' | 'pty';
  available: boolean;
}

export interface WorkerProfileDefaults {
  lifecycle: WorkerLifecycle;
  transport: WorkerTransport;
  serverUrl: string;
  appUrl: string;
  workspaceRoot: string;
  logsDir: string;
  cacheDir: string;
  stateDir: string;
  identityKeyPath: string;
  publicKey: string;
  publicKeyFingerprint: string;
  capabilities: {
    agents: WorkerCapabilityAgent[];
  };
}

export interface WorkerPairingPayload {
  runtime_role: 'worker';
  worker_lifecycle: WorkerLifecycle;
  worker_transport: WorkerTransport;
  worker_workspace_root: string;
  worker_identity_public_key: string;
  worker_identity_fingerprint: string;
  worker_capabilities: {
    agents: WorkerCapabilityAgent[];
  };
}

interface WorkerIdentityFile {
  version: 1;
  algorithm: 'ed25519';
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
  createdAt: string;
}

export function normalizeWorkerLifecycle(raw: string | undefined): WorkerLifecycle {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'persistent') return 'persistent';
  if (value === 'ephemeral') return 'ephemeral';
  throw new Error('Worker mode must be persistent or ephemeral.');
}

export function normalizeWorkerTransport(raw: string | undefined): WorkerTransport {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'polling') return 'polling';
  if (value === 'relay' || value === 'inbound') return value;
  throw new Error('Worker transport must be polling, relay, or inbound.');
}

export function defaultWorkerWorkspaceRoot(): string {
  return path.join(configDir(), 'workspace');
}

export async function resolveWorkerProfileDefaults(options?: {
  server?: PairingServerTransportConfig;
  detectCapabilities?: boolean;
}): Promise<WorkerProfileDefaults> {
  const server = options?.server ?? (await resolvePairingServerTransport(getFlag('server')));
  const lifecycle = normalizeWorkerLifecycle(getFlag('mode') ?? getFlag('lifecycle'));
  const transport = normalizeWorkerTransport(getFlag('transport'));
  const workspaceRoot = path.resolve(getFlag('workdir') ?? defaultWorkerWorkspaceRoot());
  const stateDir = path.join(configDir(), 'worker');
  const identity = await ensureWorkerIdentity(path.join(stateDir, 'identity.json'));
  const capabilities = {
    agents:
      options?.detectCapabilities === false ? [] : await detectWorkerAgentCapabilities(),
  };

  return {
    lifecycle,
    transport,
    serverUrl: server.url,
    appUrl: server.appUrl,
    workspaceRoot,
    logsDir: path.join(workspaceRoot, 'logs'),
    cacheDir: path.join(workspaceRoot, 'cache'),
    stateDir,
    identityKeyPath: path.join(stateDir, 'identity.json'),
    publicKey: identity.publicKey,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    capabilities,
  };
}

export function workerPairingPayload(profile: WorkerProfileDefaults): WorkerPairingPayload {
  return {
    runtime_role: 'worker',
    worker_lifecycle: profile.lifecycle,
    worker_transport: profile.transport,
    worker_workspace_root: profile.workspaceRoot,
    worker_identity_public_key: profile.publicKey,
    worker_identity_fingerprint: profile.publicKeyFingerprint,
    worker_capabilities: profile.capabilities,
  };
}

export async function storeWorkerProfile(
  approved: PairingPollApprovedData | null,
  profile: WorkerProfileDefaults,
): Promise<void> {
  await Promise.all([
    fs.mkdir(profile.workspaceRoot, { recursive: true }),
    fs.mkdir(profile.logsDir, { recursive: true }),
    fs.mkdir(profile.cacheDir, { recursive: true }),
    fs.mkdir(profile.stateDir, { recursive: true }),
  ]);

  const manager = new ConfigManager();
  await manager.load();
  const existing = manager.getDaemonConfig() ?? {};
  const nextWorker: NonNullable<NonNullable<ViewportConfig['daemon']>['worker']> = {
    ...(existing.worker ?? {}),
    lifecycle: profile.lifecycle,
    transport: profile.transport,
    serverUrl: profile.serverUrl,
    appUrl: profile.appUrl,
    workspaceRoot: profile.workspaceRoot,
    logsDir: profile.logsDir,
    cacheDir: profile.cacheDir,
    stateDir: profile.stateDir,
    identityKeyPath: profile.identityKeyPath,
    publicKeyFingerprint: profile.publicKeyFingerprint,
    workspaceId: approved?.workspace_id,
    managedExecutorId: approved?.managed_executor_id,
    credential: approved?.managed_executor_credential,
    capabilities: profile.capabilities,
  };
  await manager.setDaemonConfig({
    ...existing,
    server: {
      ...(existing.server ?? {}),
      url: profile.serverUrl,
      appUrl: profile.appUrl,
    },
    worker: nextWorker,
  });

  if (approved?.workspace_id) {
    await fs.writeFile(
      path.join(profile.stateDir, 'pairing.json'),
      `${JSON.stringify(
        {
          version: 1,
          workspaceId: approved.workspace_id,
          workspaceName: approved.workspace_name,
          installId: approved.install_id,
          runtimeTargetId: approved.runtime_target_id,
          managedExecutorId: approved.managed_executor_id,
          serverUrl: approved.server_url ?? profile.serverUrl,
          pairedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

export function isWorkerPairing(): boolean {
  return hasFlag('worker');
}

async function detectWorkerAgentCapabilities(): Promise<WorkerCapabilityAgent[]> {
  const registry = new AgentRegistry();
  for (const def of BUILT_IN_AGENTS) {
    registry.register(def);
  }
  const availability = await registry.detectAvailable();
  return registry.getAll().map((def) => ({
    id: def.id,
    displayName: def.displayName,
    tier: def.tier,
    available: availability.get(def.id) ?? false,
  }));
}

async function ensureWorkerIdentity(identityPath: string): Promise<WorkerIdentityFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(identityPath, 'utf8')) as Partial<WorkerIdentityFile>;
    if (
      parsed.version === 1 &&
      parsed.algorithm === 'ed25519' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string' &&
      typeof parsed.publicKeyFingerprint === 'string'
    ) {
      return parsed as WorkerIdentityFile;
    }
  } catch {
    // Generate below.
  }

  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKeyDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyFingerprint = crypto
    .createHash('sha256')
    .update(publicKeyDer)
    .digest('hex');
  const record: WorkerIdentityFile = {
    version: 1,
    algorithm: 'ed25519',
    publicKey,
    privateKey,
    publicKeyFingerprint,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  await fs.writeFile(identityPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(identityPath, 0o600);
  return record;
}
