import { ConfigManager } from '../core/config.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { resolveDisplayVersion } from '../core/package-meta.js';
import { resolveDaemonRuntimeIdentity, toInstallCapabilities } from '../core/runtime-identity.js';
import {
  fetchContextCandidateDecisionKeys,
  parseDecisionSigningKeys,
} from './remote-decision-keys.js';
import { seedRelayBindings, upsertRelayBinding } from './relay-binding-config.js';

function boolLike(value: string | undefined): boolean {
  if (!value) return false;
  const lowered = value.trim().toLowerCase();
  return lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on';
}

function asJsonMode(): boolean {
  return hasFlag('json') || getFlag('format') === 'json';
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function inferRelayEndpointFromServer(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  let relayHost = parsed.hostname;
  const isLocalHost =
    relayHost === '127.0.0.1' ||
    relayHost === 'localhost' ||
    relayHost === '::1' ||
    relayHost.endsWith('.test');

  if (relayHost.startsWith('app.')) {
    const appBaseHost = relayHost.slice(4);
    relayHost = appBaseHost.endsWith('.test') ? appBaseHost : `relay.${appBaseHost}`;
  } else if (relayHost === 'getviewport.com' || relayHost === 'getviewport.dev') {
    relayHost = `relay.${relayHost}`;
  }
  if (relayHost === 'relay.getviewport.com') {
    return `${scheme}://${relayHost}/ws`;
  }
  if (relayHost === 'relay.getviewport.dev' || isLocalHost || relayHost.endsWith('.test')) {
    return `${scheme}://${relayHost}:7781/ws`;
  }
  throw new Error(
    `Cannot infer relay endpoint from ${serverUrl}. Pass --relay-endpoint for self-hosted or custom deployments.`,
  );
}

function redact(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function usage(): string {
  return 'Usage: vpd remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <issue-token>] [--relay-endpoint <ws(s)://.../ws>] [--relay-tls-verify auto|0|1] [--context-decision-key kid:base64-public-key]';
}

function showRemoteHelp(): void {
  console.log(usage());
}

function resolveInstallMetadata(serverUrl: string, relayEndpoint: string, manager: ConfigManager) {
  const identity = resolveDaemonRuntimeIdentity({
    daemonConfig: manager.getDaemonConfig(),
    daemonVersion: resolveDisplayVersion(),
  });
  return toInstallCapabilities({
    ...identity,
    serverUrl,
    relayEndpoint,
    relayServerUrl: serverUrl,
  });
}

export async function remote(): Promise<void> {
  const args = getArgs();
  const subcommand = args[1];
  if (!subcommand) {
    showRemoteHelp();
    return;
  }

  const manager = new ConfigManager();
  await manager.load();
  const daemonConfig = manager.getDaemonConfig() ?? {};
  const relayConfig = daemonConfig.relay ?? {};
  const asJson = asJsonMode();

  if (subcommand === 'status') {
    const payload = {
      command: 'remote status',
      ok: true,
      relay: {
        enabled: relayConfig.enabled ?? false,
        bindings: (relayConfig.bindings ?? []).map((binding) => ({
          enabled: binding.enabled ?? true,
          endpoint: binding.endpoint,
          serverUrl: binding.serverUrl,
          workspaceId: binding.workspaceId,
          installId: binding.installId,
          runtimeTargetId: binding.runtimeTargetId,
          machineId: binding.machineId,
          issueToken: redact(binding.issueToken),
          tlsVerify: binding.tlsVerify ?? 'auto',
          caCertPath: binding.caCertPath,
        })),
        endpoint: relayConfig.endpoint,
        serverUrl: relayConfig.serverUrl,
        workspaceId: relayConfig.workspaceId,
        installId: relayConfig.installId,
        runtimeTargetId: relayConfig.runtimeTargetId,
        machineId: relayConfig.machineId,
        issueToken: redact(relayConfig.issueToken),
        tlsVerify: relayConfig.tlsVerify ?? 'auto',
        caCertPath: relayConfig.caCertPath,
        contextCandidateDecisionKeyIds: daemonConfig.server?.contextCandidateDecisionKeys
          ? Object.keys(daemonConfig.server.contextCandidateDecisionKeys)
          : [],
      },
    };
    if (asJson) {
      print(payload);
      return;
    }

    console.log(`Remote relay enabled: ${payload.relay.enabled ? 'yes' : 'no'}`);
    if (payload.relay.bindings.length > 0) {
      console.log(`Relay bindings:       ${payload.relay.bindings.length}`);
      for (const binding of payload.relay.bindings) {
        console.log(
          `  - ${binding.workspaceId ?? '-'} ${binding.endpoint ?? '-'} (${binding.enabled ? 'enabled' : 'disabled'})`,
        );
      }
    }
    console.log(`Relay endpoint:       ${payload.relay.endpoint ?? '-'}`);
    console.log(`Relay server:         ${payload.relay.serverUrl ?? '-'}`);
    console.log(`Workspace:            ${payload.relay.workspaceId ?? '-'}`);
    console.log(`Install:              ${payload.relay.installId ?? '-'}`);
    console.log(`Runtime target:       ${payload.relay.runtimeTargetId ?? '-'}`);
    console.log(`Machine:              ${payload.relay.machineId ?? '-'}`);
    console.log(`Issue token:          ${payload.relay.issueToken ?? '-'}`);
    console.log(`TLS verify:           ${payload.relay.tlsVerify}`);
    console.log(`CA cert path:         ${payload.relay.caCertPath ?? '-'}`);
    console.log(
      `Context decision keys: ${payload.relay.contextCandidateDecisionKeyIds.join(', ') || '-'}`,
    );
    return;
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const enabled = subcommand === 'enable';
    await manager.setDaemonConfig({
      relay: {
        ...relayConfig,
        enabled,
      },
    });
    const payload = { command: `remote ${subcommand}`, ok: true, enabled };
    if (asJson) {
      print(payload);
      return;
    }

    console.log(`Remote relay ${enabled ? 'enabled' : 'disabled'}.`);
    return;
  }

  if (subcommand === 'logout') {
    await manager.setDaemonConfig({
      relay: {
        ...relayConfig,
        enabled: false,
        installId: undefined,
        runtimeTargetId: undefined,
        machineId: undefined,
        issueToken: undefined,
      },
    });
    const payload = { command: 'remote logout', ok: true, enabled: false };
    if (asJson) {
      print(payload);
      return;
    }

    console.log('Remote relay token removed and remote mode disabled.');
    return;
  }

  if (subcommand === 'login') {
    const serverUrl = getFlag('server') ?? relayConfig.serverUrl;
    const workspaceId = getFlag('workspace') ?? relayConfig.workspaceId;
    const replaceExisting = hasFlag('replace');
    const addBinding = hasFlag('add');
    const preserveIssuedInstall = relayConfig.workspaceId === workspaceId;
    const issueToken =
      getFlag('token') ??
      getFlag('issue-token') ??
      (preserveIssuedInstall && relayConfig.serverUrl === serverUrl
        ? relayConfig.issueToken
        : undefined);

    if (!serverUrl || !workspaceId) {
      throw new Error(usage());
    }
    if (!issueToken) {
      throw new Error(
        'Missing relay issue token. Pass --token <issue-token> or --issue-token <issue-token>.',
      );
    }
    if (
      relayConfig.workspaceId &&
      !addBinding &&
      (relayConfig.workspaceId !== workspaceId || relayConfig.serverUrl !== serverUrl) &&
      !replaceExisting
    ) {
      throw new Error(
        `Remote relay is already configured for workspace ${relayConfig.workspaceId}. Re-run with --replace to replace it with ${workspaceId}.`,
      );
    }

    let relayEndpoint = getFlag('relay-endpoint') ?? relayConfig.endpoint;
    if (!relayEndpoint) {
      relayEndpoint = inferRelayEndpointFromServer(serverUrl);
    }

    const relayTlsVerify = (getFlag('relay-tls-verify') ?? relayConfig.tlsVerify ?? 'auto') as
      | 'auto'
      | '0'
      | '1';
    const relayCaCertPath = getFlag('relay-ca-cert') ?? relayConfig.caCertPath;
    let contextCandidateDecisionKeys =
      parseDecisionSigningKeys(getFlag('context-decision-key')) ??
      daemonConfig.server?.contextCandidateDecisionKeys;
    const enableNow = hasFlag('enable') || !boolLike(getFlag('no-enable'));
    const nextIssueToken = preserveIssuedInstall ? relayConfig.issueToken : undefined;
    const nextInstallId = preserveIssuedInstall ? relayConfig.installId : undefined;
    const nextRuntimeTargetId = preserveIssuedInstall ? relayConfig.runtimeTargetId : undefined;
    const nextMachineId = preserveIssuedInstall ? relayConfig.machineId : undefined;

    if (!contextCandidateDecisionKeys) {
      contextCandidateDecisionKeys = await fetchContextCandidateDecisionKeys({
        serverUrl,
        tlsVerify: relayTlsVerify,
        caCertPath: relayCaCertPath,
        tlsPins: relayConfig.tlsPins,
      });
    }

    const nextBinding = {
      enabled: enableNow,
      endpoint: relayEndpoint,
      serverUrl,
      workspaceId,
      installId: nextInstallId,
      runtimeTargetId: nextRuntimeTargetId,
      machineId: nextMachineId,
      issueToken: issueToken.trim() || nextIssueToken,
      tlsVerify: relayTlsVerify,
      caCertPath: relayCaCertPath,
      tlsPins: relayConfig.tlsPins,
      tokenIssuer: relayConfig.tokenIssuer,
      tokenAudience: relayConfig.tokenAudience,
      tokenJwksUrl: relayConfig.tokenJwksUrl,
      signingKeys: relayConfig.signingKeys,
      tokenClockSkewSec: relayConfig.tokenClockSkewSec,
    };
    const nextBindings = addBinding
      ? upsertRelayBinding(seedRelayBindings(relayConfig), nextBinding, replaceExisting)
      : undefined;

    await manager.setDaemonConfig({
      server: {
        ...(daemonConfig.server ?? {}),
        url: serverUrl,
        ...(contextCandidateDecisionKeys ? { contextCandidateDecisionKeys } : {}),
      },
      relay: {
        ...relayConfig,
        enabled: enableNow,
        bindings: nextBindings,
        endpoint: addBinding && relayConfig.workspaceId ? relayConfig.endpoint : relayEndpoint,
        serverUrl: addBinding && relayConfig.workspaceId ? relayConfig.serverUrl : serverUrl,
        workspaceId: addBinding && relayConfig.workspaceId ? relayConfig.workspaceId : workspaceId,
        installId: addBinding && relayConfig.workspaceId ? relayConfig.installId : nextInstallId,
        runtimeTargetId:
          addBinding && relayConfig.workspaceId ? relayConfig.runtimeTargetId : nextRuntimeTargetId,
        machineId: addBinding && relayConfig.workspaceId ? relayConfig.machineId : nextMachineId,
        issueToken:
          addBinding && relayConfig.workspaceId
            ? relayConfig.issueToken
            : issueToken.trim() || nextIssueToken,
        tlsVerify: addBinding && relayConfig.workspaceId ? relayConfig.tlsVerify : relayTlsVerify,
        caCertPath:
          addBinding && relayConfig.workspaceId ? relayConfig.caCertPath : relayCaCertPath,
      },
    });

    const payload = {
      command: 'remote login',
      ok: true,
      relay: {
        enabled: enableNow,
        endpoint: relayEndpoint,
        serverUrl,
        workspaceId,
        installId: nextInstallId,
        runtimeTargetId: nextRuntimeTargetId,
        machineId: nextMachineId,
        issueToken: redact(issueToken.trim() || nextIssueToken),
        tlsVerify: relayTlsVerify,
        caCertPath: relayCaCertPath,
      },
      capabilities: resolveInstallMetadata(serverUrl, relayEndpoint, manager),
      contextCandidateDecisionKeyIds: contextCandidateDecisionKeys
        ? Object.keys(contextCandidateDecisionKeys)
        : [],
      next: 'Run `vpd restart` to apply relay runtime changes.',
    };

    if (asJson) {
      print(payload);
      return;
    }

    console.log('Remote relay credentials saved.');
    console.log(`- endpoint:  ${relayEndpoint}`);
    console.log(`- server:    ${serverUrl}`);
    console.log(`- workspace: ${workspaceId}`);
    console.log(`- token:     provided`);
    console.log(`- enabled:   ${enableNow ? 'yes' : 'no'}`);
    if (contextCandidateDecisionKeys && Object.keys(contextCandidateDecisionKeys).length > 0) {
      console.log(
        `- context decision keys: ${Object.keys(contextCandidateDecisionKeys).join(', ')}`,
      );
    }
    console.log('Run `vpd restart` to apply relay runtime changes.');
    return;
  }

  throw new Error(usage());
}
