import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  addContextEntry,
  initContextProject,
  isResolverPinMismatch,
  readContextStatus,
  resolveContextBundle,
  type ContextKeyStore,
  type ContextScope,
} from '../context/local-edge-store.js';
import { pullContextEvents, pushContextEvents } from '../context/local-edge-sync.js';
import { resolveContextKeyStore } from '../context/local-edge-key-store.js';
import { resolveContextSyncTarget } from './context-sync-target.js';
import {
  contextDeviceAccept,
  contextDeviceApprove,
  contextDeviceRequest,
  contextGrant,
  contextIdentityExport,
  contextIdentityImport,
  contextJoin,
  contextUserInit,
} from './context-access-command.js';

export async function context(): Promise<void> {
  const subcommand = getArgs()[1];
  if (subcommand === 'init') {
    await initContext();
    return;
  }
  if (subcommand === 'status') {
    await contextStatus();
    return;
  }
  if (subcommand === 'add') {
    await contextAdd();
    return;
  }
  if (subcommand === 'resolve') {
    await contextResolve();
    return;
  }
  if (subcommand === 'sync-push') {
    await contextSyncPush();
    return;
  }
  if (subcommand === 'sync-pull') {
    await contextSyncPull();
    return;
  }
  if (subcommand === 'user-init') {
    await contextUserInit();
    return;
  }
  if (subcommand === 'join') {
    await contextJoin();
    return;
  }
  if (subcommand === 'identity-export') {
    await contextIdentityExport();
    return;
  }
  if (subcommand === 'identity-import') {
    await contextIdentityImport();
    return;
  }
  if (subcommand === 'device-request') {
    await contextDeviceRequest();
    return;
  }
  if (subcommand === 'device-approve') {
    await contextDeviceApprove();
    return;
  }
  if (subcommand === 'device-accept') {
    await contextDeviceAccept();
    return;
  }
  if (subcommand === 'grant') {
    await contextGrant();
    return;
  }
  throw new Error(
    'Usage: vpd context <init|status|add|resolve|sync-push|sync-pull|user-init|join|identity-export|identity-import|device-request|device-approve|device-accept|grant> ...',
  );
}

async function initContext(): Promise<void> {
  const projectId = requiredFlag(
    'project',
    'vpd context init --project <id> --user <name> --device <name>',
  );
  const userName = requiredFlag(
    'user',
    'vpd context init --project <id> --user <name> --device <name>',
  );
  const deviceName = requiredFlag(
    'device',
    'vpd context init --project <id> --user <name> --device <name>',
  );
  const record = await initContextProject({
    projectId,
    userName,
    deviceName,
    credentials: readCredentials(),
    keyStore: parseKeyStore(getFlag('key-store')),
  });

  if (isJsonMode()) {
    printJson({ command: 'context init', ok: true, project: record });
    return;
  }
  console.log(`Context initialized for project ${record.projectId}`);
  console.log(`User:        ${record.userName}`);
  console.log(`Device:      ${record.deviceName}`);
  console.log('Server sync: disabled');
}

async function contextStatus(): Promise<void> {
  const status = await readContextStatus({ projectId: getFlag('project') });
  if (isJsonMode()) {
    printJson({ command: 'context status', ok: true, ...status });
    return;
  }

  if (status.projects.length === 0) {
    console.log('No local context projects initialized.');
    return;
  }
  for (const project of status.projects) {
    console.log(`${project.projectId}  ${project.entryCount} entries  sync=${project.serverSync}`);
  }
}

async function contextAdd(): Promise<void> {
  const projectId = requiredFlag(
    'project',
    'vpd context add --project <id> --title <text> --body <text>',
  );
  const entry = await addContextEntry({
    projectId,
    actorName:
      getFlag('actor') ?? requiredFlag('device', 'vpd context add --project <id> --device <name>'),
    title: requiredFlag('title', 'vpd context add --project <id> --title <text> --body <text>'),
    body: requiredFlag('body', 'vpd context add --project <id> --title <text> --body <text>'),
    scope: parseScope(getFlag('scope')),
    source: getFlag('source'),
    credentials: readCredentials(),
  });

  if (isJsonMode()) {
    printJson({ command: 'context add', ok: true, entry });
    return;
  }
  console.log(`Context entry added: ${entry.id}`);
  console.log('Title: [encrypted]');
}

async function contextResolve(): Promise<void> {
  const projectId = requiredFlag('project', 'vpd context resolve --project <id> --query <text>');
  let bundle;
  try {
    bundle = await resolveContextBundle({
      projectId,
      actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
      query: getFlag('query') ?? '',
      includePrivate: hasFlag('include-private'),
      profile: parseProfileName(getFlag('profile')),
      profilePin: parseProfilePin(),
      credentials: readCredentials(),
    });
  } catch (error) {
    if (isResolverPinMismatch(error)) {
      throw new Error(`Context profile pin mismatch: ${(error as Error).message}`);
    }
    throw error;
  }

  if (isJsonMode()) {
    printJson({ command: 'context resolve', ok: true, bundle });
    return;
  }

  console.log(`Context bundle: ${bundle.manifest.digest}`);
  console.log(`Items:          ${bundle.manifest.itemCount}`);
  console.log('Server sync:    disabled');
  for (const item of bundle.items) {
    console.log('');
    console.log(`# ${item.title}`);
    console.log(item.body);
  }
}

async function contextSyncPush(): Promise<void> {
  const target = await resolveContextSyncTarget('sync-push');
  const result = await pushContextEvents({
    projectId: target.projectId,
    serverUrl: target.serverUrl,
    credential: target.credential,
  });

  if (isJsonMode()) {
    printJson({ command: 'context sync-push', ok: true, ...result });
    return;
  }

  console.log(`Context events pushed: ${result.accepted}/${result.pushed}`);
  console.log(`Repo: ${result.repoId}`);
}

async function contextSyncPull(): Promise<void> {
  const target = await resolveContextSyncTarget('sync-pull');
  const result = await pullContextEvents({
    projectId: target.projectId,
    serverUrl: target.serverUrl,
    credential: target.credential,
    actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
    credentials: readCredentials(),
    limit: parseLimit(getFlag('limit')),
  });

  if (isJsonMode()) {
    printJson({ command: 'context sync-pull', ok: true, ...result });
    return;
  }

  console.log(`Context events pulled: ${result.imported}/${result.pulled}`);
  console.log(`Repo: ${result.repoId}`);
}

function readCredentials(): { passphrase: string; recoveryCode: string } {
  return {
    passphrase: requiredFlag('passphrase', 'Missing --passphrase'),
    recoveryCode: requiredFlag('recovery-code', 'Missing --recovery-code'),
  };
}

function parseScope(raw: string | undefined): ContextScope {
  if (!raw) return 'project';
  if (raw === 'private' || raw === 'project' || raw === 'team' || raw === 'organization') {
    return raw;
  }
  throw new Error(`Unsupported context scope: ${raw}`);
}

function parseProfileName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.replaceAll('\\', '/');
  const fileName = normalized.split('/').pop() ?? normalized;
  return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
}

function parseProfilePin(): { path?: string; digest?: string } | undefined {
  const path = getFlag('profile-path');
  const digest = getFlag('profile-digest');
  if (!path && !digest) return undefined;
  return { path, digest };
}

function parseKeyStore(raw: string | undefined): ContextKeyStore {
  return resolveContextKeyStore(raw);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error(`Unsupported context sync limit: ${raw}`);
  }
  return value;
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(usage.startsWith('Missing') ? usage : `${usage} (missing --${name})`);
  }
  return value;
}
