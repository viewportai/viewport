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
  return `${scheme}://${parsed.hostname}:7781/ws`;
}

function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function redact(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function usage(): never {
  throw new Error(
    'Usage: vpd remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <enroll-token>] [--user <id>] [--workspace-name <name>] [--relay-endpoint <ws(s)://.../ws>] [--relay-tls-verify auto|0|1]',
  );
}

async function parseJson(res: Response): Promise<Record<string, unknown> | null> {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

async function discoverRelayEndpoint(serverUrl: string): Promise<string | null> {
  const res = await fetch(joinUrl(serverUrl, '/api/poc/relay/state'));
  if (!res.ok) return null;
  const json = await parseJson(res);
  if (!json || json.ok !== true) return null;

  const state = json.state as Record<string, unknown> | undefined;
  const wsBaseUrl = typeof state?.wsBaseUrl === 'string' ? state.wsBaseUrl : null;
  return wsBaseUrl && wsBaseUrl.length > 0 ? wsBaseUrl : null;
}

async function resetWorkspaceEnrollToken(
  serverUrl: string,
  workspaceId: string,
): Promise<{ ok: true; token: string } | { ok: false; workspaceMissing: boolean; reason: string }> {
  const res = await fetch(
    joinUrl(serverUrl, `/api/poc/workspaces/${encodeURIComponent(workspaceId)}/reset-enroll-token`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const json = await parseJson(res);

  if (res.ok && json?.ok === true && typeof json.workspaceEnrollToken === 'string') {
    return { ok: true, token: json.workspaceEnrollToken };
  }

  const reason = typeof json?.error === 'string' ? json.error : 'reset enroll token failed';
  const workspaceMissing = reason === 'workspace not found' || res.status === 404;
  return { ok: false, workspaceMissing, reason };
}

async function enrollWorkspace(
  serverUrl: string,
  workspaceId: string,
  userId: string,
  workspaceName?: string,
): Promise<{ token: string; created: boolean }> {
  const res = await fetch(joinUrl(serverUrl, '/api/poc/workspaces/enroll'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      workspaceId,
      workspaceName: workspaceName || workspaceId,
    }),
  });
  const json = await parseJson(res);

  if (res.ok && json?.ok === true && typeof json.workspaceEnrollToken === 'string') {
    return { token: json.workspaceEnrollToken, created: true };
  }

  if (res.status === 409) {
    const reset = await resetWorkspaceEnrollToken(serverUrl, workspaceId);
    if (reset.ok) {
      return { token: reset.token, created: false };
    }
    throw new Error(`Failed to reset workspace enroll token: ${reset.reason}`);
  }

  throw new Error(
    `Failed to enroll workspace: ${
      typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`
    }`,
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
        enrollToken: redact(relayConfig.enrollToken),
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
    console.log(`Enroll token:         ${payload.relay.enrollToken ?? '-'}`);
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
        enrollToken: undefined,
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
    const userId = getFlag('user');
    const workspaceName = getFlag('workspace-name');
    let enrollToken = getFlag('token') ?? relayConfig.enrollToken;

    if (!serverUrl || !workspaceId) {
      usage();
    }

    let relayEndpoint = getFlag('relay-endpoint') ?? relayConfig.endpoint;
    if (!relayEndpoint) {
      relayEndpoint =
        (await discoverRelayEndpoint(serverUrl).catch(() => null)) ??
        inferRelayEndpointFromServer(serverUrl);
    }

    let tokenSource: 'flag_or_config' | 'reset' | 'enroll' = 'flag_or_config';
    if (!enrollToken) {
      const reset = await resetWorkspaceEnrollToken(serverUrl, workspaceId);
      if (reset.ok) {
        enrollToken = reset.token;
        tokenSource = 'reset';
      } else if (reset.workspaceMissing) {
        if (!userId) {
          throw new Error(
            'Workspace not found and no --user provided. Pass --user to auto-enroll workspace, or pass --token explicitly.',
          );
        }
        const enrolled = await enrollWorkspace(serverUrl, workspaceId, userId, workspaceName);
        enrollToken = enrolled.token;
        tokenSource = 'enroll';
      } else {
        throw new Error(`Failed to obtain enroll token: ${reset.reason}`);
      }
    }

    const relayTlsVerify = (getFlag('relay-tls-verify') ?? relayConfig.tlsVerify ?? 'auto') as
      | 'auto'
      | '0'
      | '1';
    const relayCaCertPath = getFlag('relay-ca-cert') ?? relayConfig.caCertPath;
    const enableNow = hasFlag('enable') || !boolLike(getFlag('no-enable'));

    await manager.setDaemonConfig({
      relay: {
        ...relayConfig,
        enabled: enableNow,
        endpoint: relayEndpoint,
        serverUrl,
        workspaceId,
        enrollToken,
        issueToken: relayConfig.issueToken,
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
        enrollToken: redact(enrollToken),
        issueToken: redact(relayConfig.issueToken),
        tlsVerify: relayTlsVerify,
        caCertPath: relayCaCertPath,
      },
      tokenSource,
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
    console.log(`- token:     ${tokenSource}`);
    console.log(`- enabled:   ${enableNow ? 'yes' : 'no'}`);
    console.log('Run `vpd restart` to apply relay runtime changes.');
    return;
  }

  usage();
}
