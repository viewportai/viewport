import { getArgs, getFlag, hasFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import {
  printStructured,
  resolveOutputFormat,
  type OutputFormat,
  type TableColumn,
} from './command-shared.js';

interface PendingPermission {
  sessionId: string;
  requestId: string;
  toolName: string;
  description: string;
  createdAt: number;
  decisionReason?: string;
}

interface PendingResponse {
  pending: PendingPermission[];
  count: number;
}

function permitUsage(): string {
  return 'Usage: vpd permit <ls|allow|deny> ...';
}

function showPermitHelp(): void {
  console.log(permitUsage());
}

function parsePermitAction(): 'ls' | 'allow' | 'deny' {
  const action = getArgs()[1];
  if (action === 'ls' || action === 'allow' || action === 'deny') {
    return action;
  }
  throw new Error(permitUsage());
}

function parsePermitTargets(action: 'allow' | 'deny'): { sessionId: string; requestId: string } {
  const args = getArgs();
  const sessionId = args[2];
  const requestId = args[3];
  if (!sessionId || !requestId || sessionId.startsWith('--') || requestId.startsWith('--')) {
    throw new Error(`Usage: vpd permit ${action} <session-id> <request-id> [flags]`);
  }
  return { sessionId, requestId };
}

const PENDING_PERMISSION_COLUMNS: TableColumn[] = [
  { key: 'sessionId', header: 'Session' },
  { key: 'requestId', header: 'Request' },
  { key: 'toolName', header: 'Tool' },
  {
    key: 'createdAt',
    header: 'Requested',
    format: (value) => (typeof value === 'number' ? new Date(value).toISOString() : ''),
  },
  { key: 'description', header: 'Description' },
];

function emitPermitList(format: OutputFormat, payload: PendingResponse): boolean {
  if (format === 'text') {
    return false;
  }
  printStructured(
    {
      schemaVersion: 1,
      command: 'permit ls',
      ok: true,
      pending: payload.pending,
      count: payload.count,
    },
    {
      format,
      table:
        format === 'table'
          ? {
              rows: payload.pending.map((item) => ({
                sessionId: item.sessionId,
                requestId: item.requestId,
                toolName: item.toolName,
                createdAt: item.createdAt,
                description: item.description,
              })),
              columns: PENDING_PERMISSION_COLUMNS,
              emptyMessage: 'No pending permission requests.',
            }
          : undefined,
    },
  );
  return true;
}

export async function permit(): Promise<void> {
  if (!getArgs()[1]) {
    showPermitHelp();
    return;
  }

  if (!(await isDaemonRunning())) {
    throw new Error('Daemon is not running. Start it first with `vpd start`.');
  }

  const action = parsePermitAction();
  const format = resolveOutputFormat({ allowTable: action === 'ls' });
  if (action === 'ls') {
    const sessionId = getFlag('session');
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const res = await daemonFetch(`/api/permissions/pending${query}`);
    if (!res || !res.ok) {
      throw new Error('Failed to list pending permissions');
    }
    const payload = (await res.json()) as PendingResponse;
    if (emitPermitList(format, payload)) {
      return;
    }
    if (payload.pending.length === 0) {
      console.log('No pending permission requests.');
      return;
    }
    console.log('Pending permission requests\n');
    for (const item of payload.pending) {
      console.log(`${item.sessionId} ${item.requestId}`);
      console.log(`  tool:      ${item.toolName}`);
      console.log(`  requested: ${new Date(item.createdAt).toISOString()}`);
      if (item.decisionReason) {
        console.log(`  reason:    ${item.decisionReason}`);
      }
      console.log(`  desc:      ${item.description}`);
      console.log('');
    }
    return;
  }

  const { sessionId, requestId } = parsePermitTargets(action);
  const message = action === 'deny' ? getFlag('message') : undefined;
  const allowAlways = action === 'allow' && hasFlag('always');

  const res = await daemonFetch('/api/permissions/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      requestId,
      behavior: action,
      message,
      allowAlways,
    }),
  });

  if (!res || !res.ok) {
    const errorBody =
      res && res.headers.get('content-type')?.includes('application/json')
        ? ((await res.json()) as { error?: string })
        : null;
    const error = errorBody?.error ?? `Failed to ${action} permission request`;
    if (format !== 'text') {
      printStructured(
        {
          schemaVersion: 1,
          command: `permit ${action}`,
          ok: false,
          sessionId,
          requestId,
          error,
        },
        { format },
      );
      return;
    }
    throw new Error(error);
  }

  if (format !== 'text') {
    printStructured(
      {
        schemaVersion: 1,
        command: `permit ${action}`,
        ok: true,
        sessionId,
        requestId,
        allowAlways,
      },
      { format },
    );
    return;
  }

  console.log(
    `${action === 'allow' ? 'Allowed' : 'Denied'} permission ${requestId} for ${sessionId}`,
  );
}
