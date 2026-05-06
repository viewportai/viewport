import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  addContextEntry,
  initContextProject,
  readContextStatus,
  resolveContextBundle,
  type ContextScope,
} from '../context/local-edge-store.js';

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
  throw new Error('Usage: vpd context <init|status|add|resolve> ...');
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
  const bundle = await resolveContextBundle({
    projectId,
    actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
    query: getFlag('query') ?? '',
    includePrivate: hasFlag('include-private'),
    credentials: readCredentials(),
  });

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

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(usage.startsWith('Missing') ? usage : `${usage} (missing --${name})`);
  }
  return value;
}
