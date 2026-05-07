import { getArgs } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { printStructured, resolveOutputFormat } from './command-shared.js';

function parseAgentModeInput(): { sessionId: string; mode?: 'detect' | 'bypass' } {
  const args = getArgs();
  const action = args[1];
  if (action !== 'mode') {
    throw new Error(agentUsage());
  }
  const sessionId = args[2];
  const rawMode = args[3];
  if (!sessionId || sessionId.startsWith('--')) {
    throw new Error(agentUsage());
  }
  if (!rawMode || rawMode.startsWith('--')) {
    return { sessionId };
  }
  if (rawMode !== 'detect' && rawMode !== 'bypass') {
    throw new Error(`Invalid mode: ${rawMode}. Expected detect|bypass.`);
  }
  return { sessionId, mode: rawMode };
}

function agentUsage(): string {
  return 'Usage: vpd agent mode <session-id> [detect|bypass] [--json|--format <fmt>]';
}

function showAgentHelp(): void {
  console.log(agentUsage());
}

export async function agent(): Promise<void> {
  if (!getArgs()[1]) {
    showAgentHelp();
    return;
  }

  const format = resolveOutputFormat({ allowTable: true });
  if (!(await isDaemonRunning())) {
    throw new Error('Daemon is not running. Start it first with `vpd start`.');
  }

  const { sessionId, mode } = parseAgentModeInput();

  if (!mode) {
    const res = await daemonFetch(`/api/sessions/${sessionId}/mode`);
    if (!res || !res.ok) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const payload = (await res.json()) as { mode: string };
    if (format !== 'text') {
      printStructured(
        {
          schemaVersion: 1,
          command: 'agent mode',
          ok: true,
          sessionId,
          mode: payload.mode,
        },
        {
          format,
          table:
            format === 'table'
              ? {
                  rows: [{ sessionId, mode: payload.mode }],
                  columns: [
                    { key: 'sessionId', header: 'Session' },
                    { key: 'mode', header: 'Mode' },
                  ],
                }
              : undefined,
        },
      );
      return;
    }
    console.log(`${sessionId}: ${payload.mode}`);
    return;
  }

  const res = await daemonFetch(`/api/sessions/${sessionId}/mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });

  if (!res || !res.ok) {
    const errorBody =
      res && res.headers.get('content-type')?.includes('application/json')
        ? ((await res.json()) as { error?: string })
        : null;
    throw new Error(errorBody?.error ?? `Failed to set mode for ${sessionId}`);
  }

  if (format !== 'text') {
    printStructured(
      { schemaVersion: 1, command: 'agent mode', ok: true, sessionId, mode },
      {
        format,
        table:
          format === 'table'
            ? {
                rows: [{ sessionId, mode }],
                columns: [
                  { key: 'sessionId', header: 'Session' },
                  { key: 'mode', header: 'Mode' },
                ],
              }
            : undefined,
      },
    );
    return;
  }
  console.log(`${sessionId}: mode set to ${mode}`);
}
