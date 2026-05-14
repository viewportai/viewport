import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir, configFilePath } from '../core/config.js';
import {
  activeProfileInfo,
  clearCurrentProfile,
  normalizeProfileName,
  profileHomePath,
  readProfileRegistry,
  resolveViewportBaseHome,
  setCurrentProfile,
  upsertProfileRecord,
  writeProfileRegistry,
} from '../core/profiles.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { resolveLocalOrgBindingSync, writeLocalOrgBinding } from './org-binding.js';
import {
  execProfileCommand,
  printProfileEnvironment,
  profileProcesses,
  runVpdProfileSubcommand,
  shellQuote,
} from './profile-runtime-commands.js';

interface ProfileConfigOptions {
  serverUrl?: string;
  appUrl?: string;
  relayEndpoint?: string;
  listen?: string;
}

export async function profile(): Promise<void> {
  const args = getArgs();
  const subcommand = args[1] ?? 'status';
  switch (subcommand) {
    case 'create':
      await createProfile();
      return;
    case 'use':
      await useProfile(2);
      return;
    case 'ls':
    case 'list':
      await listProfiles();
      return;
    case 'status':
    case 'current':
      await profileStatus();
      return;
    case 'ps':
      await profileProcesses();
      return;
    case 'env':
    case 'shell':
      printProfileEnvironment();
      return;
    case 'exec':
      await execProfileCommand();
      return;
    case 'start':
    case 'stop':
    case 'doctor':
      await runVpdProfileSubcommand(subcommand);
      return;
    case 'clear':
      await clearProfile();
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(profileHelp());
      return;
    default:
      throw new Error(`${profileHelp()}\nUnknown profile command "${subcommand}".`);
  }
}

function profileHelp(): string {
  return [
    'Usage: vpd profile <command>',
    '',
    'Commands:',
    '  create <name> [--copy-current] [--server <url>] [--app-url <url>] [--relay <ws-url>] [--listen <host:port>] [--force] [--json]',
    '  use <name> [--json]',
    '  ls [--json]',
    '  status [--json]',
    '  ps [--json]',
    '  env <name>',
    '  exec <name> -- <command...>',
    '  start <name> [vpd start flags...]',
    '  stop <name> [vpd stop flags...]',
    '  doctor <name> [vpd doctor flags...]',
    '  clear [--json]',
    '',
    'Temporary scope:',
    '  VPD_PROFILE=prod vpd status',
    '  vpd --profile prod status',
  ].join('\n');
}

async function createProfile(): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const nameArg = args[2];
  if (!nameArg || nameArg.startsWith('--')) {
    throw new Error(profileHelp());
  }

  const name = normalizeProfileName(nameArg);
  const baseHome = resolveViewportBaseHome();
  const active = activeProfileInfo();
  const registry = await readProfileRegistry(baseHome);
  const home = profileHomePath(baseHome, name);
  const force = hasFlag('force') || hasFlag('yes');
  const copyCurrent = hasFlag('copy-current');
  if (registry.profiles[name] && !force) {
    throw new Error(`Profile "${name}" already exists. Re-run with --force to update it.`);
  }

  const options: ProfileConfigOptions = {
    serverUrl: getFlag('server') ?? getFlag('server-url'),
    appUrl: getFlag('app-url') ?? getFlag('app'),
    relayEndpoint: getFlag('relay') ?? getFlag('relay-endpoint'),
    listen: getFlag('listen'),
  };
  if (copyCurrent) {
    await copyCurrentHomeToProfile({ sourceHome: active.home, baseHome, profileHome: home });
  }
  await fs.mkdir(home, { recursive: true });
  await writeProfileConfig(home, options);
  const migratedBindings = copyCurrent ? await migrateDefaultBindingsToProfile(home, name) : 0;
  const record = upsertProfileRecord(registry, {
    name,
    home,
    serverUrl: options.serverUrl,
    appUrl: options.appUrl,
    relayEndpoint: options.relayEndpoint,
    listen: options.listen,
  });
  await writeProfileRegistry(registry, baseHome);

  const payload = {
    command: 'profile create',
    ok: true,
    profile: record,
    copiedCurrent: copyCurrent,
    migratedBindings,
    configPath: path.join(home, 'config.json'),
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log(`Created profile "${name}".`);
  if (copyCurrent) console.log('Copied current daemon home into the profile.');
  if (migratedBindings > 0) console.log(`Updated ${migratedBindings} repo binding(s).`);
  console.log(`Home:   ${home}`);
  console.log(`Config: ${payload.configPath}`);
  if (options.serverUrl) console.log(`Server: ${options.serverUrl}`);
  if (options.appUrl) console.log(`App:    ${options.appUrl}`);
  if (options.relayEndpoint) console.log(`Relay:  ${options.relayEndpoint}`);
  if (options.listen) console.log(`Listen: ${options.listen}`);
}

async function migrateDefaultBindingsToProfile(
  profileHome: string,
  profileName: string,
): Promise<number> {
  const configPath = path.join(profileHome, 'config.json');
  let config: { directories?: Record<string, { path?: unknown }> };
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      directories?: Record<string, { path?: unknown }>;
    };
  } catch {
    return 0;
  }
  const directories = Object.values(config.directories ?? {});
  let migrated = 0;
  for (const entry of directories) {
    if (typeof entry.path !== 'string' || entry.path.trim().length === 0) continue;
    const binding = resolveLocalOrgBindingSync(entry.path);
    if (!binding || binding.profileName !== 'default') continue;
    await writeLocalOrgBinding({
      directory: binding.directory,
      organizationId: binding.organizationId,
      profileName,
      streamEnabled: binding.streamEnabled,
    });
    migrated += 1;
  }
  return migrated;
}

async function copyCurrentHomeToProfile(options: {
  sourceHome: string;
  baseHome: string;
  profileHome: string;
}): Promise<void> {
  const sourceHome = path.resolve(options.sourceHome);
  const baseHome = path.resolve(options.baseHome);
  const profileHome = path.resolve(options.profileHome);
  if (sourceHome === profileHome) return;
  await fs.rm(profileHome, { recursive: true, force: true });
  await fs.mkdir(profileHome, { recursive: true });
  const entries = await fs.readdir(sourceHome, { withFileTypes: true });
  for (const entry of entries) {
    if (
      sourceHome === baseHome &&
      (entry.name === 'profiles' ||
        entry.name === 'profiles.json' ||
        entry.name === 'current-profile')
    ) {
      continue;
    }
    await fs.cp(path.join(sourceHome, entry.name), path.join(profileHome, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

export async function useProfileAlias(): Promise<void> {
  await useProfile(1);
}

async function useProfile(nameIndex: number): Promise<void> {
  const asJson = isJsonMode();
  const nameArg = getArgs()[nameIndex];
  if (!nameArg || nameArg.startsWith('--')) {
    throw new Error('Usage: vpd profile use <name> [--json]');
  }
  const baseHome = resolveViewportBaseHome();
  const name = normalizeProfileName(nameArg);
  await setCurrentProfile(name, baseHome);
  const payload = {
    command: 'profile use',
    ok: true,
    profile: name,
    home: profileHomePath(baseHome, name),
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log(`Using profile "${name}" as the machine default.`);
  console.log(`Home: ${payload.home}`);
  console.log('This affects new shells. For one terminal, run:');
  console.log(`  export VPD_PROFILE=${shellQuote(name)}`);
  console.log(`Or for one command: vpd --profile ${name} status`);
}

async function listProfiles(): Promise<void> {
  const asJson = isJsonMode();
  const baseHome = resolveViewportBaseHome();
  const registry = await readProfileRegistry(baseHome);
  const active = activeProfileInfo();
  const profiles = Object.values(registry.profiles).sort((a, b) => a.name.localeCompare(b.name));
  const payload = {
    command: 'profile ls',
    ok: true,
    active,
    profiles,
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  if (profiles.length === 0) {
    console.log('No profiles yet. Create one with vpd profile create <name>.');
    return;
  }
  for (const profile of profiles) {
    const marker = active.name === profile.name ? '*' : ' ';
    console.log(`${marker} ${profile.name}\t${profile.home}`);
  }
}

async function profileStatus(): Promise<void> {
  const asJson = isJsonMode();
  const active = activeProfileInfo();
  const payload = {
    command: 'profile status',
    ok: true,
    active,
    home: configDir(),
    configPath: configFilePath(),
    authTokenPath: path.join(configDir(), 'auth-token'),
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log(`Profile: ${active.name ?? '(default)'}`);
  console.log(`Source:  ${active.source}`);
  console.log(`Base:    ${active.baseHome}`);
  console.log(`Home:    ${payload.home}`);
  console.log(`Config:  ${payload.configPath}`);
}

async function clearProfile(): Promise<void> {
  const asJson = isJsonMode();
  const baseHome = resolveViewportBaseHome();
  await clearCurrentProfile(baseHome);
  const payload = {
    command: 'profile clear',
    ok: true,
    baseHome,
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log('Cleared the default profile. Future commands use the base ~/.viewport home.');
}

async function writeProfileConfig(home: string, options: ProfileConfigOptions): Promise<void> {
  const configPath = path.join(home, 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const daemon = normalizeRecord(existing['daemon']);
  const server = normalizeRecord(daemon['server']);
  const relay = normalizeRecord(daemon['relay']);
  const next = {
    ...existing,
    daemon: {
      ...daemon,
      ...(options.listen ? { listen: options.listen } : {}),
      server: {
        ...server,
        ...(options.serverUrl ? { url: options.serverUrl } : {}),
        ...(options.appUrl ? { appUrl: options.appUrl } : {}),
      },
      relay: {
        ...relay,
        ...(options.relayEndpoint ? { endpoint: options.relayEndpoint } : {}),
        ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
      },
    },
  };
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
