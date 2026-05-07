import { ConfigManager } from '../core/config.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { resolveDisplayVersion } from '../core/package-meta.js';
import { resolveDaemonRuntimeIdentity, toInstallCapabilities } from '../core/runtime-identity.js';

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

function usage(): never {
  throw new Error(
    'Usage: vpd remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <issue-token>] [--relay-endpoint <ws(s)://.../ws>] [--relay-tls-verify auto|0|1] [--context-decision-key kid:base64-public-key]',
  );
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
  if (!subcommand) usage();

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
        endpoint: relayConfig.endpoint,
        serverUrl: relayConfig.serverUrl,
        workspaceId: relayConfig.workspaceId,
        installId: relayConfig.installId,
        projectMachineBindingId: relayConfig.projectMachineBindingId,
        machineId: relayConfig.machineId,
        issueToken: redact(relayConfig.issueToken),
        tlsVerify: relayConfig.tlsVerify ?? 'auto',
        caCertPath: relayConfig.caCertPath,
      },
    };
    if (asJson) {
      print(payload);
      return;
    }

    console.log(`Remote relay enabled: ${payload.relay.enabled ? 'yes' : 'no'}`);
    console.log(`Relay endpoint:       ${payload.relay.endpoint ?? '-'}`);
    console.log(`Relay server:         ${payload.relay.serverUrl ?? '-'}`);
    console.log(`Workspace:            ${payload.relay.workspaceId ?? '-'}`);
    console.log(`Install:              ${payload.relay.installId ?? '-'}`);
    console.log(`Project machine:      ${payload.relay.projectMachineBindingId ?? '-'}`);
    console.log(`Machine:              ${payload.relay.machineId ?? '-'}`);
    console.log(`Issue token:          ${payload.relay.issueToken ?? '-'}`);
    console.log(`TLS verify:           ${payload.relay.tlsVerify}`);
    console.log(`CA cert path:         ${payload.relay.caCertPath ?? '-'}`);
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
        projectMachineBindingId: undefined,
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
    const preserveIssuedInstall = relayConfig.workspaceId === workspaceId;
    const issueToken =
      getFlag('token') ??
      getFlag('issue-token') ??
      (preserveIssuedInstall && relayConfig.serverUrl === serverUrl
        ? relayConfig.issueToken
        : undefined);

    if (!serverUrl || !workspaceId) {
      usage();
    }
    if (!issueToken) {
      throw new Error(
        'Missing relay issue token. Pass --token <issue-token> or --issue-token <issue-token>.',
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
    const contextCandidateDecisionKeys =
      parseDecisionSigningKeys(getFlag('context-decision-key')) ??
      daemonConfig.server?.contextCandidateDecisionKeys;
    const enableNow = hasFlag('enable') || !boolLike(getFlag('no-enable'));
    const nextIssueToken = preserveIssuedInstall ? relayConfig.issueToken : undefined;
    const nextInstallId = preserveIssuedInstall ? relayConfig.installId : undefined;
    const nextProjectMachineBindingId = preserveIssuedInstall
      ? relayConfig.projectMachineBindingId
      : undefined;
    const nextMachineId = preserveIssuedInstall ? relayConfig.machineId : undefined;

    await manager.setDaemonConfig({
      server: {
        ...(daemonConfig.server ?? {}),
        url: serverUrl,
        ...(contextCandidateDecisionKeys ? { contextCandidateDecisionKeys } : {}),
      },
      relay: {
        ...relayConfig,
        enabled: enableNow,
        endpoint: relayEndpoint,
        serverUrl,
        workspaceId,
        installId: nextInstallId,
        projectMachineBindingId: nextProjectMachineBindingId,
        machineId: nextMachineId,
        issueToken: issueToken.trim() || nextIssueToken,
        tlsVerify: relayTlsVerify,
        caCertPath: relayCaCertPath,
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
        projectMachineBindingId: nextProjectMachineBindingId,
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

  usage();
}

function parseDecisionSigningKeys(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Context candidate decision key JSON must be an object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([kid, key]) =>
        typeof key === 'string' && key.length > 0 ? [[kid, key]] : [],
      ),
    );
  }

  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error('Context candidate decision key must use kid:base64-public-key format');
  }

  return {
    [trimmed.slice(0, separator)]: trimmed.slice(separator + 1),
  };
}
