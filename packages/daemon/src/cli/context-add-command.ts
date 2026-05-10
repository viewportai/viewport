import { addContextEntry, type ContextScope } from '../context/local-edge-store.js';
import { getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { resolveWritableViewportVaultProvider } from './context-provider-resolve.js';

export async function contextAdd(): Promise<void> {
  const providerTarget = getFlag('provider')
    ? resolveWritableViewportVaultProvider({
        providerId: getFlag('provider')!,
        workingDirectory: getFlag('path') ?? getFlag('cwd') ?? process.cwd(),
      })
    : undefined;
  const contextResourceId =
    providerTarget?.contextResourceId ??
    requiredContextId('vpd context add --context <id> --title <text> --body <text>');
  const entry = await addContextEntry({
    contextResourceId,
    actorName:
      getFlag('actor') ?? requiredFlag('device', 'vpd context add --context <id> --device <name>'),
    title: requiredFlag('title', 'vpd context add --context <id> --title <text> --body <text>'),
    body: requiredFlag('body', 'vpd context add --context <id> --title <text> --body <text>'),
    scope: parseScope(getFlag('scope')),
    source: getFlag('source'),
    credentials: readCredentials(),
  });

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_add/v1',
      command: 'context add',
      ok: true,
      ...(providerTarget
        ? {
            provider_id: providerTarget.provider.id,
            provider: providerTarget.provider.provider,
            manifest_digest: providerTarget.manifest.manifestDigest,
          }
        : {}),
      entry,
    });
    return;
  }
  console.log(`Context entry added: ${entry.id}`);
  if (providerTarget) console.log(`Provider: ${providerTarget.provider.id}`);
  console.log('Title: [encrypted]');
}

function requiredContextId(usage: string): string {
  const context = getFlag('context') ?? getFlag('repo');
  if (!context || context.startsWith('--')) {
    throw new Error(`${usage} (missing --context)`);
  }
  return context;
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(`${usage} (missing --${name})`);
  }
  return value;
}

function readCredentials(): { passphrase: string; recoveryCode: string } {
  return {
    passphrase: requiredFlag('passphrase', 'context command requires --passphrase <text>'),
    recoveryCode: requiredFlag('recovery-code', 'context command requires --recovery-code <text>'),
  };
}

function parseScope(raw: string | undefined): ContextScope {
  if (!raw) return 'resource';
  if (raw === 'project') return 'resource';
  if (raw === 'resource' || raw === 'private' || raw === 'team' || raw === 'organization') {
    return raw;
  }
  throw new Error(`Unsupported context scope: ${raw}`);
}
