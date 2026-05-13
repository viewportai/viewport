import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import {
  USER_EPOCH_SCHEMA,
  type EpochDescriptor,
  type JsonValue,
} from './epoch-protocol.js';

const STORE_SCHEMA = 'viewport.local_crypto_epochs/v1';

export interface LocalUserCryptoEpoch {
  workspaceId: string;
  userId: string;
  epoch: number;
  schema: typeof USER_EPOCH_SCHEMA;
  status: 'active' | 'superseded' | 'revoked';
  encryptionPublicKeyJwk: JsonValue;
  encryptionPrivateKeyJwk: JsonValue;
  signingPublicKeyJwk: JsonValue;
  signingPrivateKeyJwk: JsonValue;
  fingerprint: string;
  previousEpochFingerprint?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LocalEpochStore {
  schema: typeof STORE_SCHEMA;
  userEpochs: LocalUserCryptoEpoch[];
}

export async function getActiveLocalUserEpoch(
  workspaceId: string,
  home = configDir(),
): Promise<LocalUserCryptoEpoch | null> {
  const store = await readLocalEpochStore(home);
  return (
    store.userEpochs
      .filter((epoch) => epoch.workspaceId === workspaceId && epoch.status === 'active')
      .sort((a, b) => b.epoch - a.epoch)[0] ?? null
  );
}

export async function upsertLocalUserEpoch(
  input: Omit<LocalUserCryptoEpoch, 'createdAt' | 'updatedAt'>,
  home = configDir(),
): Promise<LocalUserCryptoEpoch> {
  const store = await readLocalEpochStore(home);
  const now = new Date().toISOString();
  for (const epoch of store.userEpochs) {
    if (epoch.workspaceId === input.workspaceId && epoch.status === 'active') {
      epoch.status = 'superseded';
      epoch.updatedAt = now;
    }
  }
  const existing = store.userEpochs.find(
    (epoch) => epoch.workspaceId === input.workspaceId && epoch.fingerprint === input.fingerprint,
  );
  if (existing) {
    Object.assign(existing, input, { updatedAt: now });
    await writeLocalEpochStore(store, home);
    return existing;
  }

  const record: LocalUserCryptoEpoch = { ...input, createdAt: now, updatedAt: now };
  store.userEpochs.push(record);
  await writeLocalEpochStore(store, home);
  return record;
}

export function createLocalUserEpochKeyMaterial(input: {
  workspaceId: string;
  userId?: string;
  epoch?: number;
  previousEpochFingerprint?: string | null;
}): {
  descriptor: EpochDescriptor;
  encryptionPrivateKeyJwk: JsonValue;
  signingPrivateKeyJwk: JsonValue;
} {
  const encryption = crypto.generateKeyPairSync('x25519');
  const signing = crypto.generateKeyPairSync('ed25519');
  const descriptor: EpochDescriptor = {
    schema: USER_EPOCH_SCHEMA,
    workspaceId: input.workspaceId,
    subjectType: 'user',
    subjectId: input.userId ?? 'pending-platform-user',
    epoch: input.epoch ?? 1,
    encryptionPublicKeyJwk: encryption.publicKey.export({ format: 'jwk' }) as JsonValue,
    signingPublicKeyJwk: signing.publicKey.export({ format: 'jwk' }) as JsonValue,
    previousEpochFingerprint: input.previousEpochFingerprint ?? null,
    createdAt: new Date().toISOString(),
  };

  return {
    descriptor,
    encryptionPrivateKeyJwk: encryption.privateKey.export({ format: 'jwk' }) as JsonValue,
    signingPrivateKeyJwk: signing.privateKey.export({ format: 'jwk' }) as JsonValue,
  };
}

async function readLocalEpochStore(home = configDir()): Promise<LocalEpochStore> {
  try {
    const raw = await fs.readFile(localEpochStorePath(home), 'utf8');
    const parsed = JSON.parse(raw) as LocalEpochStore;
    if (parsed.schema !== STORE_SCHEMA || !Array.isArray(parsed.userEpochs)) {
      throw new Error('Invalid local crypto epoch store.');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: STORE_SCHEMA, userEpochs: [] };
    }
    throw error;
  }
}

async function writeLocalEpochStore(store: LocalEpochStore, home = configDir()): Promise<void> {
  const filePath = localEpochStorePath(home);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

function localEpochStorePath(home = configDir()): string {
  return path.join(home, 'crypto', 'epochs.json');
}
