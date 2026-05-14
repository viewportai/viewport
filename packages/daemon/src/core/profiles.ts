import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_ENV_NAMES = ['VPD_PROFILE', 'VIEWPORT_PROFILE'] as const;
export const PROFILE_REGISTRY_FILE = 'profiles.json';
export const CURRENT_PROFILE_FILE = 'current-profile';
export const PROFILES_DIR = 'profiles';

export interface DaemonProfileRecord {
  name: string;
  home: string;
  createdAt: string;
  updatedAt: string;
  serverUrl?: string;
  appUrl?: string;
  relayEndpoint?: string;
  listen?: string;
}

export interface DaemonProfileRegistry {
  version: 1;
  profiles: Record<string, DaemonProfileRecord>;
}

export interface ActiveProfileInfo {
  name: string | null;
  source: 'env' | 'current-profile' | 'none';
  baseHome: string;
  home: string;
}

export function resolveViewportBaseHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['VIEWPORT_HOME'] ?? env['VPD_HOME'];
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  return path.join(os.homedir(), '.viewport');
}

export function resolveProfileAwareViewportHome(env: NodeJS.ProcessEnv = process.env): string {
  const baseHome = resolveViewportBaseHome(env);
  const profileName = activeProfileName(env);
  if (!profileName) return baseHome;
  return profileHomePath(baseHome, profileName);
}

export function activeProfileInfo(env: NodeJS.ProcessEnv = process.env): ActiveProfileInfo {
  const baseHome = resolveViewportBaseHome(env);
  const envProfile = profileFromEnvironment(env);
  if (envProfile) {
    return {
      name: envProfile,
      source: 'env',
      baseHome,
      home: profileHomePath(baseHome, envProfile),
    };
  }

  const current = readCurrentProfileSync(baseHome);
  if (current) {
    return {
      name: current,
      source: 'current-profile',
      baseHome,
      home: profileHomePath(baseHome, current),
    };
  }

  return {
    name: null,
    source: 'none',
    baseHome,
    home: baseHome,
  };
}

export function activeProfileName(env: NodeJS.ProcessEnv = process.env): string | null {
  return activeProfileInfo(env).name;
}

export function profileHomePath(baseHome: string, name: string): string {
  return path.join(baseHome, PROFILES_DIR, normalizeProfileName(name));
}

export function registryPath(baseHome = resolveViewportBaseHome()): string {
  return path.join(baseHome, PROFILE_REGISTRY_FILE);
}

export function currentProfilePath(baseHome = resolveViewportBaseHome()): string {
  return path.join(baseHome, CURRENT_PROFILE_FILE);
}

export function normalizeProfileName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(
      'Profile names must start with a letter or number and contain only letters, numbers, dots, underscores, and dashes.',
    );
  }
  if (normalized === '.' || normalized === '..') {
    throw new Error('Profile name is not allowed.');
  }
  return normalized;
}

export function readProfileRegistrySync(
  baseHome = resolveViewportBaseHome(),
): DaemonProfileRegistry {
  try {
    return normalizeRegistry(JSON.parse(fsSync.readFileSync(registryPath(baseHome), 'utf8')));
  } catch {
    return { version: 1, profiles: {} };
  }
}

export async function readProfileRegistry(
  baseHome = resolveViewportBaseHome(),
): Promise<DaemonProfileRegistry> {
  try {
    return normalizeRegistry(JSON.parse(await fs.readFile(registryPath(baseHome), 'utf8')));
  } catch {
    return { version: 1, profiles: {} };
  }
}

export async function writeProfileRegistry(
  registry: DaemonProfileRegistry,
  baseHome = resolveViewportBaseHome(),
): Promise<void> {
  await fs.mkdir(baseHome, { recursive: true });
  await fs.writeFile(registryPath(baseHome), `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(registryPath(baseHome), 0o600);
}

export async function setCurrentProfile(
  name: string,
  baseHome = resolveViewportBaseHome(),
): Promise<void> {
  const normalized = normalizeProfileName(name);
  const registry = await readProfileRegistry(baseHome);
  if (!registry.profiles[normalized]) {
    throw new Error(`Profile "${normalized}" does not exist. Create it with vpd profile create.`);
  }
  await fs.mkdir(baseHome, { recursive: true });
  await fs.writeFile(currentProfilePath(baseHome), `${normalized}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(currentProfilePath(baseHome), 0o600);
}

export async function clearCurrentProfile(baseHome = resolveViewportBaseHome()): Promise<void> {
  await fs.rm(currentProfilePath(baseHome), { force: true });
}

export function readCurrentProfileSync(baseHome = resolveViewportBaseHome()): string | null {
  try {
    const raw = fsSync.readFileSync(currentProfilePath(baseHome), 'utf8').trim();
    if (!raw) return null;
    return normalizeProfileName(raw);
  } catch {
    return null;
  }
}

export function upsertProfileRecord(
  registry: DaemonProfileRegistry,
  record: Omit<DaemonProfileRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: string;
    updatedAt?: string;
  },
): DaemonProfileRecord {
  const name = normalizeProfileName(record.name);
  const existing = registry.profiles[name];
  const now = new Date().toISOString();
  const next: DaemonProfileRecord = {
    ...existing,
    ...record,
    name,
    home: record.home,
    createdAt: record.createdAt ?? existing?.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
  registry.profiles[name] = next;
  return next;
}

function profileFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  for (const key of PROFILE_ENV_NAMES) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return normalizeProfileName(raw);
    }
  }
  return null;
}

function normalizeRegistry(value: unknown): DaemonProfileRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, profiles: {} };
  }
  const rawProfiles = (value as { profiles?: unknown }).profiles;
  if (!rawProfiles || typeof rawProfiles !== 'object' || Array.isArray(rawProfiles)) {
    return { version: 1, profiles: {} };
  }
  const profiles: Record<string, DaemonProfileRecord> = {};
  for (const [key, rawRecord] of Object.entries(rawProfiles as Record<string, unknown>)) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) continue;
    const record = rawRecord as Partial<DaemonProfileRecord>;
    try {
      const name = normalizeProfileName(record.name ?? key);
      if (typeof record.home !== 'string' || record.home.trim().length === 0) continue;
      profiles[name] = {
        name,
        home: path.resolve(record.home),
        createdAt:
          typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
        updatedAt:
          typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl : undefined,
        appUrl: typeof record.appUrl === 'string' ? record.appUrl : undefined,
        relayEndpoint: typeof record.relayEndpoint === 'string' ? record.relayEndpoint : undefined,
        listen: typeof record.listen === 'string' ? record.listen : undefined,
      };
    } catch {
      // Ignore malformed profile records.
    }
  }
  return { version: 1, profiles };
}
