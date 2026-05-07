import { getArgs, getFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import {
  printStructured,
  resolveOutputFormat,
  type OutputFormat,
  type TableColumn,
} from './command-shared.js';

interface SessionListEntry {
  source: 'active' | 'discovered';
  sessionId: string;
  directoryId: string;
  directoryPath: string | null;
  agentId: string;
  state: string;
  mode: string;
  resumable: boolean;
  lastActivity: number | null;
  summary: string | null;
  messageCount: number | null;
}

interface SessionListResponse {
  sessions: SessionListEntry[];
  counts: {
    active: number;
    discovered: number;
    total: number;
  };
}

function shortAgo(ts: number | null): string {
  if (!ts) return '-';
  const deltaMs = Date.now() - ts;
  if (deltaMs < 60_000) return 'just now';
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeScope(raw: string | undefined): 'all' | 'active' | 'discovered' {
  if (!raw) return 'all';
  if (raw === 'all' || raw === 'active' || raw === 'discovered') return raw;
  throw new Error(`Invalid --scope value: ${raw}. Expected all|active|discovered.`);
}

function parseSessionId(): string {
  const args = getArgs();
  const sessionId = args[2];
  if (!sessionId || sessionId.startsWith('--')) {
    throw new Error(sessionUsage());
  }
  return sessionId;
}

function sessionUsage(): string {
  return 'Usage: vpd session <stop> ...';
}

export function showSessionHelp(): void {
  console.log(sessionUsage());
}

function sessionTableRows(sessions: SessionListEntry[]): Array<Record<string, unknown>> {
  return sessions.map((session) => ({
    sessionId: session.sessionId,
    source: session.source,
    agent: session.agentId,
    state: session.state,
    mode: session.mode,
    resumable: session.resumable ? 'yes' : 'no',
    activity: shortAgo(session.lastActivity),
    directoryId: session.directoryId,
  }));
}

const SESSION_TABLE_COLUMNS: TableColumn[] = [
  { key: 'sessionId', header: 'Session' },
  { key: 'source', header: 'Source' },
  { key: 'agent', header: 'Agent' },
  { key: 'state', header: 'State' },
  { key: 'mode', header: 'Mode' },
  { key: 'resumable', header: 'Resumable' },
  { key: 'activity', header: 'Activity' },
  { key: 'directoryId', header: 'Directory' },
];

function emitListSessions(
  format: OutputFormat,
  payload: SessionListResponse,
  scope: 'all' | 'active' | 'discovered',
): boolean {
  if (format === 'text') {
    return false;
  }
  printStructured(
    {
      schemaVersion: 1,
      command: 'ls',
      ok: true,
      scope,
      sessions: payload.sessions,
      counts: payload.counts,
    },
    {
      format,
      table:
        format === 'table'
          ? {
              rows: sessionTableRows(payload.sessions),
              columns: SESSION_TABLE_COLUMNS,
              emptyMessage: 'No sessions found.',
            }
          : undefined,
    },
  );
  return true;
}

export async function listSessions(): Promise<void> {
  const format = resolveOutputFormat({ allowTable: true });
  if (!(await isDaemonRunning())) {
    throw new Error('Daemon is not running. Start it first with `vpd start`.');
  }

  const scope = normalizeScope(getFlag('scope'));
  const directoryId = getFlag('directory');
  const agent = getFlag('agent');

  const query = new URLSearchParams();
  query.set('scope', scope);
  if (directoryId) query.set('directoryId', directoryId);
  if (agent) query.set('agent', agent);

  const res = await daemonFetch(`/api/sessions?${query.toString()}`);
  if (!res || !res.ok) {
    throw new Error('Failed to list sessions');
  }

  const payload = (await res.json()) as SessionListResponse;

  if (emitListSessions(format, payload, scope)) {
    return;
  }

  if (payload.sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log(`Sessions (${payload.counts.total})\n`);
  for (const session of payload.sessions) {
    console.log(`${session.sessionId}  [${session.source}]`);
    console.log(`  agent:      ${session.agentId}`);
    console.log(`  directory:  ${session.directoryId}`);
    if (session.directoryPath) {
      console.log(`  path:       ${session.directoryPath}`);
    }
    console.log(`  state/mode: ${session.state}/${session.mode}`);
    console.log(`  resumable:  ${session.resumable ? 'yes' : 'no'}`);
    console.log(`  activity:   ${shortAgo(session.lastActivity)}`);
    if (session.summary) {
      console.log(`  summary:    ${session.summary}`);
    }
    console.log('');
  }
}

export async function stopSession(): Promise<void> {
  const format = resolveOutputFormat();
  if (!(await isDaemonRunning())) {
    throw new Error('Daemon is not running. Start it first with `vpd start`.');
  }

  const sessionId = parseSessionId();
  const res = await daemonFetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });

  if (!res || !res.ok) {
    const errorBody =
      res && res.headers.get('content-type')?.includes('application/json')
        ? ((await res.json()) as { error?: string })
        : null;
    const error = errorBody?.error ?? `Failed to stop session ${sessionId}`;
    if (format !== 'text') {
      printStructured(
        { schemaVersion: 1, command: 'session stop', ok: false, sessionId, error },
        { format },
      );
      return;
    }
    throw new Error(error);
  }

  if (format !== 'text') {
    printStructured({ schemaVersion: 1, command: 'session stop', ok: true, sessionId }, { format });
    return;
  }

  console.log(`Stopped session ${sessionId}`);
}
