import type { DaemonRelayIdentity } from './bridge-key-exchange.js';
import { BridgeError } from './bridge-errors.js';
import { ConfigManager } from '../core/config.js';
import { logger as out } from '../core/output.js';
import { transportFetch } from '../cli/network.js';

interface DaemonKeyRegistrationOptions {
  relayServerUrl: string;
  workspaceId: string;
  runtimeTargetId?: string;
  relayTlsVerify?: 'auto' | '0' | '1';
  relayCaCertPath?: string;
  relayTlsPins?: string[];
}

export async function registerDaemonPublicKeyWithControlPlane(input: {
  options: DaemonKeyRegistrationOptions;
  identity: DaemonRelayIdentity | null;
  daemonIssueToken: string | null;
}): Promise<string | null> {
  if (!input.identity) {
    throw new BridgeError('DAEMON_KEY_REGISTER_FAILED', 'daemon identity unavailable');
  }

  const url =
    `${input.options.relayServerUrl.replace(/\/+$/, '')}` +
    `/api/runtime/workspaces/${encodeURIComponent(input.options.workspaceId)}/daemon-key`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  let res: Response;
  try {
    res = await transportFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: input.daemonIssueToken ?? undefined,
        daemonPublicKey: input.identity.publicKey,
        runtimeTargetId: input.options.runtimeTargetId,
      }),
      signal: controller.signal,
      tlsVerify: input.options.relayTlsVerify ?? 'auto',
      caCertPath: input.options.relayCaCertPath,
      tlsPins: input.options.relayTlsPins,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new BridgeError(
      'DAEMON_KEY_REGISTER_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
  clearTimeout(timeout);

  const parsed = (await res.json().catch(() => null)) as {
    ok?: boolean;
    reason?: string;
    error?: string;
    daemonIssueToken?: string;
    runtimeTargetId?: string;
    installId?: string;
  } | null;

  if (!res.ok || !parsed?.ok) {
    const reason = parsed?.reason ?? parsed?.error ?? `HTTP ${res.status}`;
    throw new BridgeError(
      'DAEMON_KEY_REGISTER_FAILED',
      `daemon key registration failed: ${reason}`,
    );
  }

  const issuedToken = parsed.daemonIssueToken?.trim() ?? '';
  const runtimeTargetId = parsed.runtimeTargetId?.trim() ?? input.options.runtimeTargetId;
  const installId = parsed.installId?.trim();
  await persistRegisteredBinding({
    workspaceId: input.options.workspaceId,
    issueToken: issuedToken.length > 0 ? issuedToken : input.daemonIssueToken,
    runtimeTargetId,
    installId,
  });
  if (issuedToken.length > 0) {
    return issuedToken;
  }
  if (input.daemonIssueToken && input.daemonIssueToken.trim().length > 0) {
    return input.daemonIssueToken;
  }

  throw new BridgeError(
    'DAEMON_KEY_REGISTER_FAILED',
    'daemon key registration succeeded but daemon issue token was missing',
  );
}

async function persistRegisteredBinding(input: {
  workspaceId: string;
  issueToken?: string | null;
  runtimeTargetId?: string;
  installId?: string;
}): Promise<void> {
  const normalizedIssueToken = input.issueToken?.trim() ?? '';
  const normalizedRuntimeTargetId = input.runtimeTargetId?.trim() ?? '';
  const normalizedInstallId = input.installId?.trim() ?? '';
  try {
    const manager = new ConfigManager();
    await manager.load();
    const daemonConfig = manager.getDaemonConfig() ?? {};
    const relayConfig = daemonConfig.relay ?? {};
    const bindings = relayConfig.bindings?.map((binding) => {
      if (binding.workspaceId !== input.workspaceId) return binding;
      return {
        ...binding,
        ...(normalizedIssueToken ? { issueToken: normalizedIssueToken } : {}),
        ...(normalizedRuntimeTargetId ? { runtimeTargetId: normalizedRuntimeTargetId } : {}),
        ...(normalizedInstallId ? { installId: normalizedInstallId } : {}),
      };
    });

    await manager.setDaemonConfig({
      ...daemonConfig,
      relay: {
        ...relayConfig,
        ...(normalizedIssueToken ? { issueToken: normalizedIssueToken } : {}),
        ...(normalizedRuntimeTargetId ? { runtimeTargetId: normalizedRuntimeTargetId } : {}),
        ...(normalizedInstallId ? { installId: normalizedInstallId } : {}),
        ...(bindings ? { bindings } : {}),
      },
    });
  } catch (error) {
    out.warn(
      `[relay] failed to persist daemon registration data: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
