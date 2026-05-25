/**
 * CLI command: vpd hook notify
 *
 * Called by agent hooks (e.g., Claude Code's ~/.claude/settings.json hooks).
 * Reads hook event JSON from stdin, POSTs to the running daemon, and either
 * returns immediately (non-blocking events) or blocks waiting for a supervisor
 * response (PermissionRequest).
 *
 * Exit codes:
 *   0 — daemon handled the event (decision JSON on stdout if applicable)
 *   1 — daemon not running, not supervised, or timeout → agent falls through to local UI
 */

import { getFlag, hasFlag } from './args.js';
import { daemonEndpointLabel, daemonFetch, resolveDaemonEndpoint } from './daemon-client.js';
import {
  getHookAdapterCapabilities,
  listHookAdapterCapabilities,
  type HookAdapterCapabilityProfile,
} from '../hooks/capabilities.js';

const HOOK_TIMEOUT_MS = 125_000; // slightly > daemon's 120s to let daemon timeout first

export function showHookHelp(): void {
  process.stdout.write(
    [
      'Usage: vpd hook <notify|plan|plan-proposed|capabilities> ...',
      '       vpd hook notify --event <EventName>',
      '       vpd hook plan < hook-payload.json',
      '       vpd hook capabilities [--adapter <name>] [--json]',
      '',
    ].join('\n'),
  );
}

export async function hookNotify(forcedEvent?: string): Promise<void> {
  const event = forcedEvent ?? getFlag('event');
  const input = await readStdin();
  const exitCode = await runHookNotify(input, {
    event,
    writeStdout: (message) => process.stdout.write(message),
    writeStderr: (message) => process.stderr.write(message),
  });
  process.exit(exitCode);
}

interface HookNotifyOptions {
  event?: string;
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
}

export async function runHookNotify(input: string, options: HookNotifyOptions = {}): Promise<number> {
  const event = options.event;
  const writeStdout = options.writeStdout ?? ((message: string) => process.stdout.write(message));
  const writeStderr = options.writeStderr ?? ((message: string) => process.stderr.write(message));

  if (!event) {
    writeStderr('Usage: vpd hook notify --event <EventName>\n');
    return 1;
  }

  if (!input) {
    // No stdin — construct minimal input from args
    writeStderr('vpd hook: no input on stdin\n');
    return 1;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(input) as Record<string, unknown>;
  } catch {
    writeStderr('vpd hook: invalid JSON on stdin\n');
    return 1;
  }

  // Ensure hook_event_name is set
  if (!body.hook_event_name) {
    body.hook_event_name = event;
  }

  try {
    const endpoint = await resolveDaemonEndpoint();
    // Show waiting message for blocking hooks
    if (event === 'PermissionRequest') {
      const toolName = (body.tool_name as string) ?? 'unknown tool';
      writeStderr(
        `\x1b[33m⏳ Permission request sent to Viewport (${toolName})\x1b[0m\n` +
          `   Waiting for remote response... Press Ctrl+C to handle locally.\n`,
      );
    }

    const res = await daemonFetch('/api/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: HOOK_TIMEOUT_MS,
    });
    if (!res) {
      writeStderr(
        `Viewport daemon not reachable at ${daemonEndpointLabel(endpoint)}. Start it with \`vpd start --foreground\` or run \`vpd status\` for recovery details.\n`,
      );
      return 1;
    }
    if (!res.ok) {
      writeStderr(`Viewport daemon rejected hook event ${event} with HTTP ${res.status}.\n`);
      return 1;
    }

    const result = (await res.json()) as {
      passthrough?: boolean;
      decision?: unknown;
      hookSpecificOutput?: unknown;
      suppressOutput?: boolean;
    };

    if (result.passthrough) {
      // Daemon says: not supervised or timed out — let agent handle locally
      return 1;
    }

    // Return the decision (PermissionRequest) or acknowledgment
    if (result.decision) {
      writeStdout(JSON.stringify(formatHookDecision(event, result.decision)) + '\n');
    } else if (result.hookSpecificOutput) {
      writeStdout(
        JSON.stringify({
          hookSpecificOutput: result.hookSpecificOutput,
          suppressOutput: result.suppressOutput ?? true,
        }) + '\n',
      );
    }

    return 0;
  } catch (err) {
    // Exit 1 so the agent falls through to its local UI
    writeStderr(
      `Viewport hook notify failed: ${err instanceof Error ? err.message : String(err)}.\n`,
    );
    return 1;
  }
}

function formatHookDecision(event: string, decision: unknown): Record<string, unknown> {
  if (!isDecisionObject(decision)) {
    return { decision };
  }

  if (event !== 'PermissionRequest') {
    return { decision };
  }

  const behavior = decision.behavior === 'deny' ? 'deny' : 'allow';
  const outputDecision: { behavior: 'allow' | 'deny'; message?: string } = { behavior };
  if (behavior === 'deny' && typeof decision.message === 'string' && decision.message.trim()) {
    outputDecision.message = decision.message.trim();
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: outputDecision,
    },
  };
}

function isDecisionObject(value: unknown): value is { behavior?: unknown; message?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function hookCapabilities(): Promise<void> {
  const adapter = getFlag('adapter');
  const profiles = adapter ? [getHookAdapterCapabilities(adapter)] : listHookAdapterCapabilities();

  if (hasFlag('json')) {
    process.stdout.write(JSON.stringify({ adapters: profiles }, null, 2) + '\n');
    return;
  }

  for (const profile of profiles) {
    printCapabilityProfile(profile);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => resolve(''), 1000);

    if (process.stdin.isTTY) {
      clearTimeout(timeout);
      resolve('');
      return;
    }

    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve('');
    });
    process.stdin.resume();
  });
}

function printCapabilityProfile(profile: HookAdapterCapabilityProfile): void {
  process.stdout.write(`${profile.displayName} (${profile.adapter})\n`);
  process.stdout.write(`  Plan boundary: ${profile.planBoundary}\n`);
  for (const capability of profile.capabilities) {
    const mark = capability.supported ? 'yes' : 'no';
    process.stdout.write(`  ${mark.padEnd(3)} ${capability.capability} - ${capability.note}\n`);
  }
  process.stdout.write('\n');
}
