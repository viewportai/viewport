import fs from 'node:fs/promises';
import { getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  acceptContextDeviceApproval,
  approveContextDeviceRequest,
  createContextDeviceRequest,
  exportContextIdentity,
  grantContextUser,
  importContextIdentity,
  initContextUser,
  joinContextProject,
  type ContextKeyStore,
} from '../context/local-edge-store.js';
import { resolveContextKeyStore } from '../context/local-edge-key-store.js';

export async function contextUserInit(): Promise<void> {
  const result = await initContextUser({
    userName: requiredFlag('user', 'vpd context user-init --user <name> --device <name>'),
    deviceName: requiredFlag('device', 'vpd context user-init --user <name> --device <name>'),
    credentials: readCredentials(),
    keyStore: parseKeyStore(getFlag('key-store')),
    home: getFlag('home'),
  });
  await writeOutput('context user-init', result, `Context user initialized: ${result.userName}`);
}

export async function contextJoin(): Promise<void> {
  const result = await joinContextProject({
    projectId: requiredFlag(
      'project',
      'vpd context join --project <id> --user <name> --device <name>',
    ),
    userName: requiredFlag('user', 'vpd context join --project <id> --user <name> --device <name>'),
    deviceName: requiredFlag(
      'device',
      'vpd context join --project <id> --user <name> --device <name>',
    ),
    credentials: readCredentials(),
    keyStore: parseKeyStore(getFlag('key-store')),
    home: getFlag('home'),
  });
  await writeOutput(
    'context join',
    { project: result },
    `Context project joined: ${result.projectId}`,
  );
}

export async function contextIdentityExport(): Promise<void> {
  const identity = exportContextIdentity({
    name: requiredFlag('name', 'vpd context identity-export --name <identity>'),
    home: getFlag('home'),
  });
  await writeOutput(
    'context identity-export',
    { identity },
    `Context identity exported: ${identity.name}`,
  );
}

export async function contextIdentityImport(): Promise<void> {
  const identity = unwrapRecord(await readJsonArg('identity', 'identity-file'), 'identity');
  const imported = importContextIdentity({ identity, home: getFlag('home') });
  await writeOutput(
    'context identity-import',
    { identity: imported },
    `Context identity imported: ${imported.name}`,
  );
}

export async function contextDeviceRequest(): Promise<void> {
  const request = createContextDeviceRequest({
    deviceName: requiredFlag('device', 'vpd context device-request --device <name> --code <code>'),
    code: requiredFlag('code', 'vpd context device-request --device <name> --code <code>'),
    keyStore: parseKeyStore(getFlag('key-store')),
    home: getFlag('home'),
  });
  await writeOutput(
    'context device-request',
    { request },
    'Context device approval request created',
  );
}

export async function contextDeviceApprove(): Promise<void> {
  const approval = await approveContextDeviceRequest({
    userName: requiredFlag(
      'user',
      'vpd context device-approve --user <name> --request-file <path> --code <code>',
    ),
    request: unwrapRecord(await readJsonArg('request', 'request-file'), 'request'),
    code: requiredFlag(
      'code',
      'vpd context device-approve --user <name> --request-file <path> --code <code>',
    ),
    credentials: readCredentials(),
    home: getFlag('home'),
  });
  await writeOutput('context device-approve', { approval }, 'Context device approval created');
}

export async function contextDeviceAccept(): Promise<void> {
  const device = await acceptContextDeviceApproval({
    userName: requiredFlag(
      'user',
      'vpd context device-accept --user <name> --device <name> --approval-file <path> --code <code>',
    ),
    deviceName: requiredFlag(
      'device',
      'vpd context device-accept --user <name> --device <name> --approval-file <path> --code <code>',
    ),
    approval: unwrapRecord(await readJsonArg('approval', 'approval-file'), 'approval'),
    code: requiredFlag(
      'code',
      'vpd context device-accept --user <name> --device <name> --approval-file <path> --code <code>',
    ),
    keyStore: parseKeyStore(getFlag('key-store')),
    home: getFlag('home'),
  });
  await writeOutput('context device-accept', { device }, 'Context device approval accepted');
}

function unwrapRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Expected JSON object for ${key}`);
  }
  const record = value as Record<string, unknown>;
  const nested = record[key];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
}

export async function contextGrant(): Promise<void> {
  const result = await grantContextUser({
    projectId: requiredFlag(
      'project',
      'vpd context grant --project <id> --actor <device> --recipient <user>',
    ),
    actorName: requiredFlag(
      'actor',
      'vpd context grant --project <id> --actor <device> --recipient <user>',
    ),
    recipientName: requiredFlag(
      'recipient',
      'vpd context grant --project <id> --actor <device> --recipient <user>',
    ),
    credentials: readCredentials(),
    home: getFlag('home'),
  });
  await writeOutput('context grant', result, `Context grant created: ${result.repoId}`);
}

async function readJsonArg(flagName: string, fileFlagName: string): Promise<unknown> {
  const inline = getFlag(flagName);
  if (inline) return JSON.parse(inline) as unknown;
  const file = requiredFlag(fileFlagName, `Missing --${flagName} or --${fileFlagName}`);
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

function readCredentials(): { passphrase: string; recoveryCode: string } {
  return {
    passphrase: requiredFlag('passphrase', 'Missing --passphrase'),
    recoveryCode: requiredFlag('recovery-code', 'Missing --recovery-code'),
  };
}

function parseKeyStore(raw: string | undefined): ContextKeyStore {
  return resolveContextKeyStore(raw);
}

async function writeOutput(
  command: string,
  payload: Record<string, unknown>,
  text: string,
): Promise<void> {
  const outFile = getFlag('out');
  if (outFile) {
    await fs.writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }
  if (isJsonMode()) {
    printJson({ command, ok: true, ...payload });
    return;
  }
  console.log(text);
  if (outFile) console.log(`Wrote: ${outFile}`);
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(usage.startsWith('Missing') ? usage : `${usage} (missing --${name})`);
  }
  return value;
}
