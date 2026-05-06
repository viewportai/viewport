import fs from 'node:fs/promises';
import path from 'node:path';
import { decryptText, unwrapProjectKey } from './local-edge-crypto.js';
import { createVault, ensureRepo, ensureUserAndDevice } from './local-edge-engine.js';
import {
  archivedContextProjectPath,
  legacyContextProjectPath,
  repoIdForProject,
} from './local-edge-paths.js';
import {
  SERVER_SYNC_MODE,
  type ContextCredentials,
  type LegacyContextProjectRecord,
} from './local-edge-types.js';

export async function migrateLegacyProjectIfNeeded(options: {
  projectId: string;
  home: string;
  credentials: ContextCredentials;
}): Promise<void> {
  const legacy = await readLegacyProjectRecord(options.projectId, options.home);
  if (!legacy) return;

  const vault = createVault(options.home);
  await ensureUserAndDevice(vault, {
    userName: legacy.userName,
    deviceName: legacy.deviceName,
    credentials: options.credentials,
  });
  await ensureRepo(vault, {
    repoId: repoIdForProject(legacy.projectId),
    projectId: legacy.projectId,
    userName: legacy.userName,
    deviceName: legacy.deviceName,
    home: options.home,
  });

  const projectKey = unwrapProjectKey(legacy.wrappedProjectKey, options.credentials);
  for (const entry of legacy.entries) {
    vault.addEntry({
      repoId: repoIdForProject(legacy.projectId),
      actorName: entry.actorName || legacy.deviceName,
      scope: entry.scope,
      title: decryptText(entry.title, projectKey),
      body: decryptText(entry.body, projectKey),
      source: entry.source,
      sourceKind: 'human',
      trustState: 'approved',
      appliesTo: [],
    });
  }

  await archiveLegacyProject(options.projectId, options.home);
}

async function readLegacyProjectRecord(
  projectId: string,
  home: string,
): Promise<LegacyContextProjectRecord | null> {
  const file = legacyContextProjectPath(projectId, home);
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (!isLegacyProjectRecord(raw)) {
      throw new Error(`Invalid seam-v0 local context project record for ${projectId}`);
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function archiveLegacyProject(projectId: string, home: string): Promise<void> {
  const source = legacyContextProjectPath(projectId, home);
  const target = archivedContextProjectPath(projectId, home);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.rename(source, target);
}

function isLegacyProjectRecord(value: unknown): value is LegacyContextProjectRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LegacyContextProjectRecord>;
  return (
    record.schemaVersion === 'viewport.context_local_edge/seam-v0' &&
    typeof record.projectId === 'string' &&
    record.serverSync === SERVER_SYNC_MODE &&
    Array.isArray(record.entries) &&
    typeof record.wrappedProjectKey?.ciphertext === 'string'
  );
}
