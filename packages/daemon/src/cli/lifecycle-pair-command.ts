import { resolveDaemonRuntimeIdentity, toInstallCapabilities } from '../core/runtime-identity.js';
import { resolveDisplayVersion } from '../core/package-meta.js';
import { loadOrCreateIdentity as loadOrCreateRelayIdentity } from '../relay/bridge-key-exchange.js';
import { getOrCreateTrustAnchor, rotateAuthToken } from '../server/pairing-offers.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson, waitForDaemonReady } from './command-shared.js';
import { transportFetch } from './network.js';
import { openUrl } from './open-url.js';
import { resolveDefaultPairingName } from './pairing-name-resolver.js';
import {
  joinPairingUrl,
  pollForApproval,
  resolvePairingServerTransport,
  storePairingCredentials,
} from './lifecycle-pair-server.js';
import {
  isWorkerPairing,
  resolveWorkerProfileDefaults,
  storeWorkerProfile,
  workerPairingPayload,
  type WorkerProfileDefaults,
} from './worker-profile.js';

interface PairingCommandOptions {
  restartDaemon: () => Promise<void>;
}

interface PairingClaimData {
  status: 'claimed';
  workspace_name?: string;
  status_token: string;
}

interface PairingCreateData {
  code: string;
  expires_at?: string;
  status_token: string;
}

export async function runPairCommand(options: PairingCommandOptions): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const pairCommandIndex = args[0] === 'daemon' && args[1] === 'pair' ? 1 : 0;
  const pairSubcommand = args[pairCommandIndex + 1];

  if (pairSubcommand === 'rotate-token') {
    const result = await rotateAuthToken();
    if (asJson) {
      printJson({
        command: 'pair rotate-token',
        ok: true,
        previousTokenExisted: result.previousTokenExisted,
        restarted: false,
      });
      return;
    }
    console.log('Rotated daemon auth token on disk.');
    console.log('Restart the daemon for the new token to take effect.');
    return;
  }

  if (pairSubcommand === 'anchor') {
    const anchor = await getOrCreateTrustAnchor();
    if (asJson) {
      printJson({
        command: 'pair anchor',
        ok: true,
        trustAnchor: anchor.fingerprint,
        trustAnchorId: anchor.id,
        createdAt: anchor.createdAt,
      });
      return;
    }
    console.log(`Trust anchor: ${anchor.fingerprint}`);
    console.log(`Anchor ID:    ${anchor.id}`);
    console.log(`Created:      ${new Date(anchor.createdAt).toISOString()}`);
    return;
  }

  const possibleCode = pairSubcommand;
  const isCode =
    possibleCode && !possibleCode.startsWith('--') && /^[A-Za-z0-9]{4,12}$/.test(possibleCode);

  if (isCode) {
    await pairWithCode(possibleCode, undefined, asJson, options.restartDaemon);
  } else {
    await pairWithoutCode(undefined, asJson, options.restartDaemon);
  }
}

async function autoRestartDaemon(
  silent: boolean,
  restartDaemon: () => Promise<void>,
): Promise<void> {
  if (!silent) {
    console.log('Restarting daemon...');
  }
  try {
    await restartDaemon();
    if (!silent) {
      console.log('Daemon restarted.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!silent) {
      console.log(`Could not restart the daemon automatically: ${message}`);
      console.log('Run `vpd restart` and check `vpd status` if the daemon is still restarting.');
    }
    throw new Error(message);
  }

  try {
    await waitForDaemonReady({ requireRelayConnected: true, timeoutMs: 10_000 });
    if (!silent) {
      console.log('Relay connection active.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!silent) {
      console.log(`Relay is still reconnecting: ${message}`);
      console.log('Check `vpd status` if it does not connect shortly.');
    }
  }
}

async function pairWithCode(
  code: string,
  explicitServerUrl: string | undefined,
  asJson: boolean,
  restartDaemon: () => Promise<void>,
): Promise<void> {
  const relayIdentity = await loadOrCreateRelayIdentity();
  const name = await resolveDefaultPairingName();
  const server = await resolvePairingServerTransport(explicitServerUrl);
  const runtimeIdentity = resolveDaemonRuntimeIdentity({
    daemonVersion: resolveDisplayVersion(),
    daemonConfig: server.daemonConfig,
  });
  const autoUnlock = resolveAutoUnlockPreference();
  const installCapabilities = toInstallCapabilities({
    ...runtimeIdentity,
    serverUrl: server.url,
    relayServerUrl: server.url,
  });
  const workerProfile = isWorkerPairing()
    ? await resolveWorkerProfileDefaults({ server })
    : undefined;

  if (!asJson) {
    console.log(`Claiming pairing code ${code}...`);
  }

  let claimRes: Response;
  try {
    claimRes = await transportFetch(
      joinPairingUrl(server.url, `/api/pairing-codes/${encodeURIComponent(code)}/claim`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          public_key: relayIdentity.publicKey,
          device_id: relayIdentity.deviceId,
          daemon_version: installCapabilities.runtime.daemonVersion,
          runtime_kind: installCapabilities.runtime.runtimeKind,
          daemon_home_scope: installCapabilities.runtime.daemonHomeScope,
          profile: installCapabilities.runtime.profile,
          server_url: installCapabilities.runtime.serverUrl,
          relay_endpoint: installCapabilities.runtime.relayEndpoint,
          relay_server_url: installCapabilities.runtime.relayServerUrl,
          auto_unlock_requested: autoUnlock.enabled,
          auto_unlock_ttl_seconds: autoUnlock.ttlSeconds,
          ...(workerProfile ? workerPairingPayload(workerProfile) : {}),
        }),
        tlsVerify: server.tlsVerify,
        caCertPath: server.caCertPath,
        tlsPins: server.tlsPins,
      },
    );
  } catch (err) {
    throw new Error(
      `Network error claiming pairing code at ${server.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!claimRes.ok) {
    const body = (await claimRes.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${claimRes.status}`;
    throw new Error(`Failed to claim pairing code: ${message}`);
  }

  const appUrl = server.appUrl;
  const claimData = (await parseJsonResponse(
    claimRes,
    server.url,
    'claim pairing code',
  )) as PairingClaimData;

  if (typeof claimData.status_token !== 'string' || claimData.status_token.trim() === '') {
    throw new Error('Pairing claim did not return a status token.');
  }

  if (!asJson) {
    console.log('Code claimed. Waiting for approval...');
    console.log(`  Approve in your browser at: ${appUrl}`);
    console.log('');
  }

  const approved = await pollForApproval(code, server, claimData.status_token, asJson);
  await storePairingCredentials(approved, server.url);
  if (workerProfile) {
    await storeWorkerProfile(approved, workerProfile);
  }
  await autoRestartDaemon(asJson, restartDaemon);

  if (asJson) {
    printJson({
      command: 'pair',
      ok: true,
      flow: 'code-claim',
      code,
      workspaceId: approved.workspace_id,
      workspaceName: approved.workspace_name,
      worker: workerProfile ? workerJson(workerProfile) : undefined,
      restarted: true,
    });
    return;
  }

  console.log('Paired successfully!');
  if (approved.workspace_name) {
    console.log(`  Workspace: ${approved.workspace_name}`);
  }
  if (workerProfile) {
    printWorkerPairedSummary(workerProfile);
  }
  console.log('');
}

async function pairWithoutCode(
  explicitServerUrl: string | undefined,
  asJson: boolean,
  restartDaemon: () => Promise<void>,
): Promise<void> {
  const relayIdentity = await loadOrCreateRelayIdentity();
  const name = await resolveDefaultPairingName();
  const server = await resolvePairingServerTransport(explicitServerUrl);
  const runtimeIdentity = resolveDaemonRuntimeIdentity({
    daemonVersion: resolveDisplayVersion(),
    daemonConfig: server.daemonConfig,
  });
  const autoUnlock = resolveAutoUnlockPreference();
  const installCapabilities = toInstallCapabilities({
    ...runtimeIdentity,
    serverUrl: server.url,
    relayServerUrl: server.url,
  });
  const workerProfile = isWorkerPairing()
    ? await resolveWorkerProfileDefaults({ server })
    : undefined;

  let createRes: Response;
  try {
    createRes = await transportFetch(joinPairingUrl(server.url, '/api/pairing-codes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        public_key: relayIdentity.publicKey,
        device_id: relayIdentity.deviceId,
        daemon_version: installCapabilities.runtime.daemonVersion,
        runtime_kind: installCapabilities.runtime.runtimeKind,
        daemon_home_scope: installCapabilities.runtime.daemonHomeScope,
        profile: installCapabilities.runtime.profile,
        server_url: installCapabilities.runtime.serverUrl,
        relay_endpoint: installCapabilities.runtime.relayEndpoint,
        relay_server_url: installCapabilities.runtime.relayServerUrl,
        auto_unlock_requested: autoUnlock.enabled,
        auto_unlock_ttl_seconds: autoUnlock.ttlSeconds,
        ...(workerProfile ? workerPairingPayload(workerProfile) : {}),
      }),
      tlsVerify: server.tlsVerify,
      caCertPath: server.caCertPath,
      tlsPins: server.tlsPins,
    });
  } catch (err) {
    throw new Error(
      `Network error creating pairing code at ${server.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!createRes.ok) {
    const contentType = createRes.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? ((await createRes.json().catch(() => null)) as Record<string, unknown> | null)
      : null;
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${createRes.status}`;
    throw new Error(`Failed to create pairing code: ${message}`);
  }

  const data = (await parseJsonResponse(
    createRes,
    server.url,
    'create pairing code',
  )) as PairingCreateData;
  const code = data.code;
  const statusToken = typeof data.status_token === 'string' ? data.status_token.trim() : '';
  if (statusToken === '') {
    throw new Error('Pairing code response missing status token.');
  }

  const appUrl = server.appUrl;
  const pairUrl = `${appUrl}/pair?code=${encodeURIComponent(code)}`;

  if (!asJson) {
    console.log('');
    console.log('  Enter this code in the Viewport web app:');
    console.log('');
    console.log(`    ${code}`);
    console.log('');
    console.log(`  Or visit: ${pairUrl}`);
    console.log('');
  }

  try {
    openUrl(pairUrl);
  } catch {
    // Opening the browser is best effort.
  }

  const approved = await pollForApproval(code, server, statusToken, asJson);
  await storePairingCredentials(approved, server.url);
  if (workerProfile) {
    await storeWorkerProfile(approved, workerProfile);
  }
  await autoRestartDaemon(asJson, restartDaemon);

  if (asJson) {
    printJson({
      command: 'pair',
      ok: true,
      flow: 'code-create',
      code,
      workspaceId: approved.workspace_id,
      workspaceName: approved.workspace_name,
      worker: workerProfile ? workerJson(workerProfile) : undefined,
      restarted: true,
    });
    return;
  }

  console.log('Paired successfully!');
  if (approved.workspace_name) {
    console.log(`  Workspace: ${approved.workspace_name}`);
  }
  if (workerProfile) {
    printWorkerPairedSummary(workerProfile);
  }
  console.log('');
}

function workerJson(profile: WorkerProfileDefaults): Record<string, unknown> {
  return {
    lifecycle: profile.lifecycle,
    transport: profile.transport,
    serverUrl: profile.serverUrl,
    workspaceRoot: profile.workspaceRoot,
    publicKeyFingerprint: profile.publicKeyFingerprint,
    capabilities: profile.capabilities,
  };
}

function printWorkerPairedSummary(profile: WorkerProfileDefaults): void {
  console.log(`  Worker mode: ${profile.lifecycle}`);
  console.log(`  Transport:   ${profile.transport}`);
  console.log(`  Work root:   ${profile.workspaceRoot}`);
}

function resolveAutoUnlockPreference(): { enabled: boolean; ttlSeconds?: number } {
  const ttlFlag = getFlag('auto-unlock-ttl') ?? getFlag('unlock-ttl');
  const parsedTtl = ttlFlag ? Number.parseInt(ttlFlag, 10) : undefined;
  const ttlSeconds =
    parsedTtl && Number.isFinite(parsedTtl) ? Math.max(300, Math.min(parsedTtl, 3600)) : undefined;

  if (hasFlag('no-auto-unlock')) {
    return { enabled: false, ttlSeconds };
  }

  return { enabled: true, ttlSeconds };
}

async function parseJsonResponse(
  response: Response,
  serverUrl: string,
  action: string,
): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const body = await response.text().catch(() => '');
    const hint = body.trimStart().startsWith('<')
      ? ' The server returned HTML; use the API/landing host such as https://getviewport.test, not the app host such as https://app.getviewport.test.'
      : '';
    throw new Error(
      `Failed to ${action} at ${serverUrl}: expected JSON but received ${contentType || 'unknown content type'}.${hint}`,
    );
  }

  return response.json();
}
