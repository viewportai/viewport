import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';

const DEFAULT_MAX_PEER_BINDINGS = 2048;
const DEFAULT_PAIRING_AUDIT_MAX_BYTES = 1_048_576;

let auditMutationLock: Promise<unknown> = Promise.resolve();

function withAuditMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = auditMutationLock.then(operation, operation);
  auditMutationLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function pairingAuditMaxBytes(): number {
  return parsePositiveInt(
    process.env['VIEWPORT_PAIRING_AUDIT_MAX_BYTES'],
    DEFAULT_PAIRING_AUDIT_MAX_BYTES,
  );
}

export function pairingPeerBindingsMax(): number {
  return parsePositiveInt(
    process.env['VIEWPORT_PAIRING_PEER_BINDINGS_MAX'],
    DEFAULT_MAX_PEER_BINDINGS,
  );
}

export function pairingStorePath(): string {
  return path.join(configDir(), 'pairing-offers.json');
}

export function pairingAuditPath(): string {
  return path.join(configDir(), 'pairing-audit.jsonl');
}

export function authTokenPath(): string {
  return path.join(configDir(), 'auth-token');
}

export function trustAnchorPath(): string {
  return path.join(configDir(), 'pairing-trust-anchor.json');
}

export function daemonIdentityPath(): string {
  return path.join(configDir(), 'pairing-device-identity.json');
}

export function peerBindingPath(): string {
  return path.join(configDir(), 'pairing-peers.json');
}

export function pairingSecretStoreKeyPath(): string {
  return path.join(configDir(), 'pairing-secret-store.key');
}

export async function appendPairingAudit(event: Record<string, unknown>): Promise<void> {
  return await withAuditMutationLock(async () => {
    await fs.mkdir(configDir(), { recursive: true });
    const auditPath = pairingAuditPath();
    const maxBytes = pairingAuditMaxBytes();
    try {
      const stat = await fs.stat(auditPath);
      if (stat.size >= maxBytes) {
        const rotated = `${auditPath}.1`;
        await fs.rm(rotated, { force: true });
        await fs.rename(auditPath, rotated);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const line = JSON.stringify({ timestamp: Date.now(), ...event });
    await fs.appendFile(auditPath, `${line}\n`, { encoding: 'utf-8', mode: 0o600 });
  });
}
