import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  initContextResource,
  isResolverPinMismatch,
  joinContextResource,
  readContextStatus,
  resolveContextBundle,
  type ContextKeyStore,
} from '../context/local-edge-store.js';
import { proposeContextEntry } from '../context/local-edge-candidates.js';
import { readCandidateDecisionApplications } from '../context/local-edge-decision-applications.js';
import {
  processPendingContextGrants,
  processPendingContextRevocations,
  publishContextPublicIdentity,
  pullContextEvents,
  pushContextEvents,
} from '../context/local-edge-sync.js';
import { resolveContextKeyStore } from '../context/local-edge-key-store.js';
import { resolveContextSyncTarget, resolveWorkspaceSyncTarget } from './context-sync-target.js';
import { parseLimit, parseMaxItems, parseSince } from './context-command-parsers.js';
import { transportFetch } from './network.js';
import { contextAdd } from './context-add-command.js';
import { contextGet, contextProviderPropose, contextSearch } from './context-provider-command.js';
import { contextVaultCreate, contextVaultsList } from './context-vault-metadata-command.js';
import { contextVaultUse } from './context-vault-use-command.js';
import { contextCandidatePreview } from './context-candidate-preview-command.js';
import { contextRulesInstall } from './context-rules-command.js';
import { ensureUserCryptoEpoch } from '../security/epoch-sync.js';
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
  if (!subcommand) {
    showContextHelp();
    return;
  }
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
  if (subcommand === 'create') {
    await contextVaultCreate();
    return;
  }
  if (subcommand === 'vaults' || subcommand === 'list') {
    await contextVaultsList();
    return;
  }
  if (subcommand === 'use') {
    await contextVaultUse();
    return;
  }
  if (subcommand === 'search') {
    await contextSearch();
    return;
  }
  if (subcommand === 'get') {
    await contextGet();
    return;
  }
  if (subcommand === 'propose') {
    if (getFlag('provider') || !getFlag('context')) {
      await contextProviderPropose();
      return;
    }
    await contextPropose();
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
  if (subcommand === 'sync-all') {
    await contextSyncAll();
    return;
  }
  if (subcommand === 'identity-publish') {
    await contextIdentityPublish();
    return;
  }
  if (subcommand === 'epoch-publish') {
    await contextEpochPublish();
    return;
  }
  if (subcommand === 'grants-process') {
    await contextGrantsProcess();
    return;
  }
  if (subcommand === 'revokes-process') {
    await contextRevokesProcess();
    return;
  }
  if (subcommand === 'decisions') {
    await contextDecisions();
    return;
  }
  if (subcommand === 'candidate-preview') {
    await contextCandidatePreview();
    return;
  }
  if (subcommand === 'rules' && getArgs()[2] === 'install') {
    await contextRulesInstall();
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
  throw new Error(contextUsage());
}

function contextUsage(): string {
  return 'Usage: vpd context <create|vaults|use|init|status|add|search|get|propose|resolve|sync-push|sync-pull|sync-all|identity-publish|epoch-publish|grants-process|revokes-process|decisions|candidate-preview|rules install|user-init|join|identity-export|identity-import|device-request|device-approve|device-accept|grant> ...';
}

function showContextHelp(): void {
  console.log(contextUsage());
}

async function initContext(): Promise<void> {
  const contextResourceId = requiredContextId(
    'vpd context init --context <id> --user <name> --device <name>',
  );
  const userName = requiredFlag(
    'user',
    'vpd context init --context <id> --user <name> --device <name>',
  );
  const deviceName = requiredFlag(
    'device',
    'vpd context init --context <id> --user <name> --device <name>',
  );
  const record = await initContextResource({
    contextResourceId,
    userName,
    deviceName,
    credentials: readCredentials(),
    keyStore: parseKeyStore(getFlag('key-store')),
  });

  if (isJsonMode()) {
    printJson({ command: 'context init', ok: true, context: record });
    return;
  }
  console.log(`Context initialized: ${record.contextResourceId}`);
  console.log(`User:        ${record.userName}`);
  console.log(`Device:      ${record.deviceName}`);
  console.log('Server sync: disabled');
}

async function contextStatus(): Promise<void> {
  const status = await readContextStatus({ contextResourceId: getContextId() });
  if (isJsonMode()) {
    printJson({ command: 'context status', ok: true, ...status });
    return;
  }

  if (status.contexts.length === 0) {
    console.log('No local context resources initialized.');
    return;
  }
  for (const context of status.contexts) {
    console.log(
      `${context.contextResourceId}  ${context.entryCount} entries  sync=${context.serverSync}`,
    );
  }
}

async function contextPropose(): Promise<void> {
  const contextResourceId = requiredContextId(
    'vpd context propose --context <id> --title <text> --body <text>',
  );
  const candidate = await proposeContextEntry({
    contextResourceId,
    actorName:
      getFlag('actor') ??
      requiredFlag('device', 'vpd context propose --context <id> --device <name>'),
    title: requiredFlag('title', 'vpd context propose --context <id> --title <text> --body <text>'),
    body: requiredFlag('body', 'vpd context propose --context <id> --title <text> --body <text>'),
    source: getFlag('source'),
    sourceKind: parseSourceKind(getFlag('source-kind')),
    credentials: readCredentials(),
  });

  if (isJsonMode()) {
    printJson({ command: 'context propose', ok: true, candidate });
    return;
  }
  console.log(`Context candidate proposed: ${candidate.id}`);
  console.log('Title: [encrypted]');
}

async function contextResolve(): Promise<void> {
  const contextResourceId = requiredContextId('vpd context resolve --context <id> --query <text>');
  let bundle;
  try {
    bundle = await resolveContextBundle({
      contextResourceId,
      actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
      query: getFlag('query') ?? '',
      maxItems: parseMaxItems(getFlag('max-items')),
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
    contextResourceId: target.contextResourceId,
    workspaceId: target.workspaceId,
    serverUrl: target.serverUrl,
    credential: target.credential,
    tlsVerify: target.tlsVerify,
    caCertPath: target.caCertPath,
    tlsPins: target.tlsPins,
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
    contextResourceId: target.contextResourceId,
    workspaceId: target.workspaceId,
    serverUrl: target.serverUrl,
    credential: target.credential,
    tlsVerify: target.tlsVerify,
    caCertPath: target.caCertPath,
    tlsPins: target.tlsPins,
    actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
    credentials: readCredentials(),
    trustedDecisionKeys: target.decisionSigningKeys,
    limit: parseLimit(getFlag('limit')),
  });

  if (isJsonMode()) {
    printJson({ command: 'context sync-pull', ok: true, ...result });
    return;
  }

  console.log(`Context events pulled: ${result.imported}/${result.pulled}`);
  console.log(`Repo: ${result.repoId}`);
}

async function contextSyncAll(): Promise<void> {
  const target = await resolveWorkspaceSyncTarget('sync-all');
  const home = getFlag('home');
  const userName = requiredFlag('user', 'vpd context sync-all --user <name> --device <name>');
  const deviceName = requiredFlag('device', 'vpd context sync-all --user <name> --device <name>');
  const credentials = readCredentials({ required: false });
  const keyStore = parseKeyStore(getFlag('key-store'));
  const vaults = await fetchVisibleContextVaults(target);
  const results = [];

  for (const vault of vaults) {
    const contextResourceId = vault.vault_id;
    if (!contextResourceId || vault.access?.can_view === false) continue;
    const status = await readContextStatus({ contextResourceId, home });
    if (status.contexts.length === 0) {
      await joinContextResource({
        contextResourceId,
        userName,
        deviceName,
        credentials,
        keyStore,
        home,
      });
    }
    const pulled = await pullContextEvents({
      contextResourceId,
      workspaceId: target.workspaceId,
      serverUrl: target.serverUrl,
      credential: target.credential,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
      actorName: deviceName,
      credentials,
      limit: parseLimit(getFlag('limit')),
      home,
    });
    results.push({ contextResourceId, ...pulled });
  }

  const summary = {
    vaults: results.length,
    pulled: results.reduce((total, item) => total + item.pulled, 0),
    imported: results.reduce((total, item) => total + item.imported, 0),
    materializedGrants: results.reduce((total, item) => total + item.materializedGrants, 0),
  };

  if (isJsonMode()) {
    printJson({ command: 'context sync-all', ok: true, workspaceId: target.workspaceId, ...summary, results });
    return;
  }

  console.log(`Context vaults synced: ${summary.vaults}`);
  console.log(`Context events pulled: ${summary.imported}/${summary.pulled}`);
  if (summary.materializedGrants > 0) {
    console.log(`Context grants materialized: ${summary.materializedGrants}`);
  }
}

async function fetchVisibleContextVaults(target: {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
}): Promise<Array<{ vault_id: string; access?: { can_view?: boolean } | null }>> {
  const query = new URLSearchParams({ credential: target.credential });
  const response = await transportFetch(
    `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(target.workspaceId)}/context-vaults?${query.toString()}`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    },
  );
  const payload = (await response.json()) as { data?: unknown };
  if (!response.ok) {
    throw new Error(`Failed to list context vaults for sync-all: HTTP ${response.status}`);
  }
  if (!Array.isArray(payload.data)) return [];
  return payload.data
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      vault_id: String(item.vault_id ?? ''),
      access:
        item.access && typeof item.access === 'object' && !Array.isArray(item.access)
          ? (item.access as { can_view?: boolean })
          : null,
    }))
    .filter((item) => item.vault_id.length > 0);
}

async function contextIdentityPublish(): Promise<void> {
  const target = await resolveWorkspaceSyncTarget('identity-publish');
  const result = await publishContextPublicIdentity({
    workspaceId: target.workspaceId,
    serverUrl: target.serverUrl,
    credential: target.credential,
    identityName: requiredFlag('name', 'vpd context identity-publish --name <identity>'),
    tlsVerify: target.tlsVerify,
    caCertPath: target.caCertPath,
    tlsPins: target.tlsPins,
    home: getFlag('home'),
  });

  if (isJsonMode()) {
    printJson({ command: 'context identity-publish', ok: true, ...result });
    return;
  }

  console.log(`Context public identity published: ${result.identityId}`);
  if (result.fingerprint) console.log(`Fingerprint: ${result.fingerprint}`);
}

async function contextEpochPublish(): Promise<void> {
  const target = await resolveWorkspaceSyncTarget('epoch-publish');
  const epoch = await ensureUserCryptoEpoch({
    target: {
      workspaceId: target.workspaceId,
      serverUrl: target.serverUrl,
      credential: target.credential,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    },
    home: getFlag('home'),
  });

  if (isJsonMode()) {
    printJson({ command: 'context epoch-publish', ok: true, epoch });
    return;
  }

  console.log(`User crypto epoch ready: ${epoch.fingerprint}`);
  console.log(`Epoch: ${epoch.epoch}`);
}

async function contextGrantsProcess(): Promise<void> {
  const target = await resolveContextSyncTarget('grants-process');
  const result = await processPendingContextGrants({
    contextResourceId: target.contextResourceId,
    workspaceId: target.workspaceId,
    serverUrl: target.serverUrl,
    credential: target.credential,
    tlsVerify: target.tlsVerify,
    caCertPath: target.caCertPath,
    tlsPins: target.tlsPins,
    actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
    credentials: readCredentials(),
    home: getFlag('home'),
  });

  if (isJsonMode()) {
    printJson({ command: 'context grants-process', ok: true, ...result });
    return;
  }

  console.log(`Context grants emitted: ${result.emitted}`);
  if (result.missingIdentity > 0) {
    console.log(`Missing recipient identities: ${result.missingIdentity}`);
  }
}

async function contextRevokesProcess(): Promise<void> {
  const target = await resolveContextSyncTarget('revokes-process');
  const result = await processPendingContextRevocations({
    contextResourceId: target.contextResourceId,
    workspaceId: target.workspaceId,
    serverUrl: target.serverUrl,
    credential: target.credential,
    tlsVerify: target.tlsVerify,
    caCertPath: target.caCertPath,
    tlsPins: target.tlsPins,
    actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
    credentials: readCredentials(),
    home: getFlag('home'),
  });

  if (isJsonMode()) {
    printJson({ command: 'context revokes-process', ok: true, ...result });
    return;
  }

  console.log(`Context revocations processed: ${result.revoked}`);
  if (result.missingIdentity > 0) {
    console.log(`Missing recipient identities: ${result.missingIdentity}`);
  }
}

async function contextDecisions(): Promise<void> {
  const since = parseSince(getFlag('since'));
  const applications = await readCandidateDecisionApplications({
    contextResourceId: getContextId(),
    since,
    home: getFlag('home'),
  });

  if (isJsonMode()) {
    printJson({ command: 'context decisions', ok: true, applications });
    return;
  }

  if (applications.length === 0) {
    console.log('No context candidate decisions applied locally.');
    return;
  }
  for (const application of applications) {
    const reason = application.reason ? ` (${application.reason})` : '';
    console.log(
      `${application.applied_at}  ${application.status}  ${application.decision}  ${application.actor_name}${reason}`,
    );
  }
}

function readCredentials(options?: { required?: boolean }): {
  passphrase: string;
  recoveryCode: string;
} {
  if (options?.required === false) {
    return {
      passphrase: getFlag('passphrase') ?? '',
      recoveryCode: getFlag('recovery-code') ?? '',
    };
  }
  return {
    passphrase: requiredFlag('passphrase', 'Missing --passphrase'),
    recoveryCode: requiredFlag('recovery-code', 'Missing --recovery-code'),
  };
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

function parseSourceKind(raw: string | undefined): 'workflow' | 'plan' | 'integration' | undefined {
  if (!raw) return undefined;
  if (raw === 'workflow' || raw === 'plan' || raw === 'integration') {
    return raw;
  }
  throw new Error(`Unsupported context candidate source kind: ${raw}`);
}

function parseKeyStore(raw: string | undefined): ContextKeyStore {
  return resolveContextKeyStore(raw);
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(usage.startsWith('Missing') ? usage : `${usage} (missing --${name})`);
  }
  return value;
}

function requiredContextId(usage: string): string {
  const value = getContextId();
  if (!value || value.startsWith('--')) {
    throw new Error(`${usage} (missing --context)`);
  }
  return value;
}

function getContextId(): string | undefined {
  return getFlag('context') ?? getFlag('project');
}
