import { ConfigManager } from '../core/config.js';
import { getArgs, getFlag, hasFlag } from './args.js';

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
    'Usage: vpd remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <issue-token>] [--relay-endpoint <ws(s)://.../ws>] [--relay-tls-verify auto|0|1]',
  );
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
    const enableNow = hasFlag('enable') || !boolLike(getFlag('no-enable'));
    const nextIssueToken = preserveIssuedInstall ? relayConfig.issueToken : undefined;
    const nextInstallId = preserveIssuedInstall ? relayConfig.installId : undefined;

    await manager.setDaemonConfig({
      relay: {
        ...relayConfig,
        enabled: enableNow,
        endpoint: relayEndpoint,
        serverUrl,
        workspaceId,
        installId: nextInstallId,
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
        issueToken: redact(issueToken.trim() || nextIssueToken),
        tlsVerify: relayTlsVerify,
        caCertPath: relayCaCertPath,
      },
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
    console.log('Run `vpd restart` to apply relay runtime changes.');
    return;
  }

  usage();
}
