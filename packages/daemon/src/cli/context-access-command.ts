import fs from 'node:fs/promises';
import { getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  initContextUser,
  joinContextResource,
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
  const result = await joinContextResource({
    contextResourceId: requiredContextId(
      'vpd context join --context <id> --user <name> --device <name>',
    ),
    userName: requiredFlag('user', 'vpd context join --context <id> --user <name> --device <name>'),
    deviceName: requiredFlag(
      'device',
      'vpd context join --context <id> --user <name> --device <name>',
    ),
    credentials: readCredentials(),
    keyStore: parseKeyStore(getFlag('key-store')),
    home: getFlag('home'),
  });
  await writeOutput(
    'context join',
    { context: result },
    `Context joined: ${result.contextResourceId}`,
  );
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

function requiredContextId(usage: string): string {
  const value = getFlag('context');
  if (!value || value.startsWith('--')) {
    throw new Error(`${usage} (missing --context)`);
  }
  return value;
}
