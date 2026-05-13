import { getArgs, getFlag, hasFlag } from './args.js';
import { resolveWorkspaceSyncTarget } from './context-sync-target.js';
import { transportFetch } from './network.js';
import { printJson } from './command-shared.js';

export async function unlock(): Promise<void> {
  const unlockSessionId = getArgs()[1] ?? getFlag('id') ?? getFlag('session');
  if (!unlockSessionId || unlockSessionId.startsWith('--')) {
    throw new Error(
      'Usage: vpd unlock <unlock-session-id> [--workspace <id>] [--server-url <url>] [--credential <token>] [--json]',
    );
  }

  const target = await resolveWorkspaceSyncTarget('unlock');
  const response = await transportFetch(
    `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
      target.workspaceId,
    )}/trusted-edge-unlock-sessions/${encodeURIComponent(unlockSessionId)}/activate`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ credential: target.credential }),
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
      timeoutMs: 10_000,
    },
  );

  const body = (await response.json().catch(() => ({}))) as {
    data?: { id?: string; status?: string; expires_at?: string | null };
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      body.message ?? `Failed to unlock trusted edge session: HTTP ${response.status}`,
    );
  }

  if (hasFlag('json')) {
    printJson({ command: 'unlock', ok: true, workspaceId: target.workspaceId, ...body.data });
    return;
  }

  console.log(`Trusted edge unlocked for workspace ${target.workspaceId}.`);
  console.log(`Session: ${body.data?.id ?? unlockSessionId}`);
  console.log(`Expires: ${body.data?.expires_at ?? 'unknown'}`);
}
