import { getFlag, hasFlag } from './args.js';
import {
  clearDaemonRuntimeState,
  readDaemonRuntimeState,
  stopPid,
  DEFAULT_STOP_TIMEOUT_MS,
  waitForPidExit,
  readProcessInfo,
  isOwnershipMatch,
  isPidRunning,
  type DaemonRuntimeState,
} from './daemon-lifecycle.js';
import { startWithLaunchConfig } from '../startup.js';
import {
  isJsonMode,
  parseTimeoutMs,
  printJson,
  requestLifecycle,
  waitForDaemonReady,
} from './command-shared.js';
import { resolveDaemonSettingsFromSources } from './daemon-settings.js';
import { runPairCommand } from './lifecycle-pair-command.js';
import { resolveDefaultPairingName } from './pairing-name-resolver.js';
export { doctor } from './lifecycle-doctor-command.js';
export { resolveDefaultPairingName };
export { status } from './lifecycle-status-command.js';
export { update } from './lifecycle-update-command.js';

export function showDaemonHelp(): void {
  console.log('Usage: vpd daemon <start|doctor|status|stop|restart|pair|update|service|setup> ...');
}

export async function stop(options?: {
  exitOnNotRunning?: boolean;
  silent?: boolean;
}): Promise<void> {
  const exitOnNotRunning = options?.exitOnNotRunning ?? true;
  const silent = options?.silent ?? false;
  const asJson = isJsonMode();
  const timeoutMs = parseTimeoutMs(getFlag('timeout'), DEFAULT_STOP_TIMEOUT_MS);
  const force = hasFlag('force');

  const state = await readDaemonRuntimeState();
  const pid = state?.ownerPid;

  if (!state || !pid) {
    if (!silent && asJson) {
      printJson({ command: 'stop', action: 'not_running', reason: 'missing_state' });
    } else if (!silent) {
      console.log('Daemon is not running');
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  if (!isPidRunning(pid)) {
    await clearDaemonRuntimeState();
    if (!silent && asJson) {
      printJson({ command: 'stop', action: 'not_running', reason: 'stale_pid_file', pid });
    } else if (!silent) {
      console.log(`Daemon is not running (stale state for pid ${pid})`);
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  const processInfo = readProcessInfo(pid);
  if (!isOwnershipMatch(state, processInfo)) {
    if (!silent && asJson) {
      printJson({
        command: 'stop',
        action: 'not_running',
        reason: 'ownership_mismatch',
        pid,
        processInfo,
      });
    } else if (!silent) {
      console.log(`Refusing to stop pid ${pid}: runtime ownership metadata mismatch.`);
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  const lifecycleRequested = await requestLifecycle('shutdown');

  if (lifecycleRequested) {
    const exited = await waitForPidExit(pid, timeoutMs);
    if (!exited) {
      if (!force) {
        throw new Error(
          `Timed out waiting for daemon owner pid ${pid} to exit after lifecycle shutdown`,
        );
      }
      await stopPid(pid, { timeoutMs: 1_000, force: true, useProcessGroup: true });
      await clearDaemonRuntimeState();
      if (!silent && asJson) {
        printJson({ command: 'stop', action: 'stopped', forced: true, pid });
        return;
      }
      if (!silent) {
        console.log(`Force-stopped daemon owner process group (pid ${pid})`);
      }
      return;
    }

    await clearDaemonRuntimeState();
    if (!silent && asJson) {
      printJson({ command: 'stop', action: 'stopped', forced: false, pid, via: 'lifecycle' });
      return;
    }
    if (!silent) {
      console.log(`Stopped daemon gracefully (owner pid ${pid})`);
    }
    return;
  }

  const result = await stopPid(pid, { timeoutMs, force, useProcessGroup: true });
  await clearDaemonRuntimeState();

  if (!silent && asJson) {
    printJson({
      command: 'stop',
      action: result === 'not-running' ? 'not_running' : 'stopped',
      forced: result === 'force-stopped',
      pid,
      via: 'signal',
    });
    return;
  }

  if (result === 'not-running') {
    if (!silent) {
      console.log('Daemon was not running');
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  if (result === 'force-stopped') {
    if (!silent) {
      console.log(`Force-stopped daemon owner process group (pid ${pid})`);
    }
    return;
  }

  if (!silent) {
    console.log(`Stopped daemon (pid ${pid})`);
  }
}

export async function restart(): Promise<void> {
  const asJson = isJsonMode();
  await restartDaemon();
  if (asJson) {
    printJson({ command: 'restart', ok: true });
    return;
  }
  console.log('Daemon restarted.');
}

function applyRuntimeOverrides(
  launch: Awaited<ReturnType<typeof resolveDaemonSettingsFromSources>>['launch'],
  runtimeState: Awaited<ReturnType<typeof readDaemonRuntimeState>>,
): Awaited<ReturnType<typeof resolveDaemonSettingsFromSources>>['launch'] {
  if (!runtimeState) {
    return launch;
  }

  return {
    ...launch,
    listen:
      runtimeState.listen ??
      (runtimeState.socketPath
        ? `unix://${runtimeState.socketPath}`
        : `${runtimeState.host}:${runtimeState.port}`),
    host: runtimeState.host,
    port: runtimeState.socketPath ? 0 : runtimeState.port,
    socketPath: runtimeState.socketPath,
    profile: runtimeState.profile ?? launch.profile,
    allowedHostsRaw: runtimeState.allowedHostsRaw ?? launch.allowedHostsRaw,
    allowedOriginsRaw: runtimeState.allowedOriginsRaw ?? launch.allowedOriginsRaw,
    authEnabled: runtimeState.authEnabled ?? launch.authEnabled,
    logPath: runtimeState.logPath ?? launch.logPath,
    relayEnabled: launch.relayEnabled,
    relayEndpoint: launch.relayEndpoint ?? runtimeState.relayEndpoint,
    relayServerUrl: launch.relayServerUrl ?? runtimeState.relayServerUrl,
    relayWorkspaceId: launch.relayWorkspaceId ?? runtimeState.relayWorkspaceId,
    relayRuntimeTargetId: launch.relayRuntimeTargetId ?? runtimeState.relayRuntimeTargetId,
    relayMachineId: launch.relayMachineId ?? runtimeState.relayMachineId,
    relayTlsVerify: launch.relayTlsVerify ?? runtimeState.relayTlsVerify,
  };
}

function applyRuntimeTlsEnvironment(
  runtimeState: Awaited<ReturnType<typeof readDaemonRuntimeState>>,
): () => void {
  const keys = [
    'VIEWPORT_TLS',
    'VIEWPORT_TLS_HOST',
    'VIEWPORT_TLS_CERT_DIR',
    'VIEWPORT_TLS_CERT',
    'VIEWPORT_TLS_KEY',
  ];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  if (runtimeState?.tlsEnabled) {
    setEnv('VIEWPORT_TLS', '1');
    setEnv('VIEWPORT_TLS_HOST', runtimeState.tlsHost?.trim() || 'localhost');
    const certDir = runtimeState.tlsCertDir?.trim() || undefined;
    setEnv('VIEWPORT_TLS_CERT_DIR', certDir);
    if (certDir) {
      setEnv('VIEWPORT_TLS_CERT', undefined);
      setEnv('VIEWPORT_TLS_KEY', undefined);
    } else {
      setEnv('VIEWPORT_TLS_CERT', runtimeState.tlsCertPath?.trim() || undefined);
      setEnv('VIEWPORT_TLS_KEY', runtimeState.tlsKeyPath?.trim() || undefined);
    }
  } else if (runtimeState?.tlsEnabled === false) {
    setEnv('VIEWPORT_TLS', '0');
    setEnv('VIEWPORT_TLS_HOST', undefined);
    setEnv('VIEWPORT_TLS_CERT_DIR', undefined);
    setEnv('VIEWPORT_TLS_CERT', undefined);
    setEnv('VIEWPORT_TLS_KEY', undefined);
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      setEnv(key, value);
    }
  };
}

function applyRuntimeResourceOverrideEnvironment(
  runtimeState: Awaited<ReturnType<typeof readDaemonRuntimeState>>,
): () => void {
  const keys = ['VIEWPORT_RESOURCE_OVERRIDE_DIR', 'VPD_RESOURCE_OVERRIDE_DIR'];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  if (runtimeState?.resourceOverrideConfigDir) {
    setEnv('VIEWPORT_RESOURCE_OVERRIDE_DIR', runtimeState.resourceOverrideConfigDir);
    setEnv('VPD_RESOURCE_OVERRIDE_DIR', undefined);
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      setEnv(key, value);
    }
  };
}

async function hardRestartFromRuntimeState(runtimeState: DaemonRuntimeState | null): Promise<void> {
  if (runtimeState?.ownerPid) {
    await stopPid(runtimeState.ownerPid, {
      timeoutMs: 1_500,
      force: true,
      useProcessGroup: true,
    });
    await clearDaemonRuntimeState();
  }

  const resolved = await resolveDaemonSettingsFromSources();
  const launch = applyRuntimeOverrides(resolved.launch, runtimeState);
  const restoreEnv = applyRuntimeTlsEnvironment(runtimeState);
  const restoreResourceOverrideEnv = applyRuntimeResourceOverrideEnvironment(runtimeState);
  try {
    await startWithLaunchConfig(launch, { silent: true });
    await waitForDaemonReady({ requireRelayConnected: false, timeoutMs: 45_000 });
  } finally {
    restoreResourceOverrideEnv();
    restoreEnv();
  }
}

export async function restartDaemon(): Promise<void> {
  const runtimeState = await readDaemonRuntimeState();
  await hardRestartFromRuntimeState(runtimeState);
}

export async function pair(): Promise<void> {
  await runPairCommand({ restartDaemon });
}

export function showHelp(): void {
  console.log('Viewport Daemon (vpd) — monitor and control AI coding agents\n');
  console.log('Usage: vpd <command> [options]\n');
  console.log('Output: --json or --format text|json|yaml|table (table where supported)\n');
  console.log('Commands:');
  console.log(
    '  start [--foreground] [--listen <host:port|port|/path.sock>] [--profile local|lan|relay] [--allowed-hosts <hosts>] [--allowed-origins <hosts>] [--auth] [--home <path>]',
  );
  console.log('                               Start the daemon (detached by default)');
  console.log(
    '  daemon <subcommand>          Lifecycle ops (start, doctor, status, stop, restart, pair, update, service, setup)',
  );
  console.log('  setup [--yes|--choose]       First-run guided setup (recommended or custom)');
  console.log('  install [--json]             Detect available agents and install hooks');
  console.log('  bind [path] [--org <organization-id>] [--yes] [--json]');
  console.log(
    '                               Authorize a local directory tree to stream to a paired organization',
  );
  console.log('  add <path> [--json]          Register a directory');
  console.log('  remove <path> [--json]       Unregister a directory');
  console.log('  list [--json]                List directories + active sessions');
  console.log(
    '  doctor [--json]              Show daemon identity, runtime mode, and active targets',
  );
  console.log('  status [--json] [--check-updates]');
  console.log('                               Daemon health and runtime status');
  console.log('  stop [--json] [--timeout <seconds>] [--force]');
  console.log('                               Stop daemon gracefully (with optional forced kill)');
  console.log('  restart                       Stop then start daemon');
  console.log('  run [<dir>] --prompt <text>  Launch a session (auto-registers directory)');
  console.log(
    '  ls [--scope all|active|discovered] [--directory <id>] [--agent <id>] [--json|--format <fmt>]',
  );
  console.log('                               List active/discovered sessions');
  console.log('  session stop <sid> [--json|--format <fmt>]  Stop an active session');
  console.log('  session manifest --session <sid> [--json|--format <fmt>]');
  console.log(
    '                               Print provider/workflow/approval manifest for a session',
  );
  console.log('  send <sid> --prompt <text>   Send a prompt to an active session');
  console.log('  logs <sid> [--follow]        Replay or follow session updates');
  console.log('  wait <sid> [--timeout <s>]   Block until a session ends');
  console.log('  attach <sid>                 Follow session updates until completion');
  console.log('  permit ls [--session <sid>] [--json|--format <fmt>]');
  console.log('  permit allow <sid> <rid> [--always] [--json|--format <fmt>]');
  console.log('  permit deny <sid> <rid> [--message <reason>] [--json|--format <fmt>]');
  console.log('                               Manage pending permission requests');
  console.log('  agent mode <sid> [detect|bypass] [--json|--format <fmt>]');
  console.log(
    '                               Read/set operator control mode for an active session',
  );
  console.log('  worktree ls [--session <sid>] [--json|--format <fmt>]');
  console.log('  worktree diffs <sid> [--json|--format <fmt>]');
  console.log('  worktree summary <sid> [--json|--format <fmt>]');
  console.log('  worktree rollback <sid> <sha> [--json|--format <fmt>]');
  console.log('  worktree retry <sid> <sha> [--json|--format <fmt>]');
  console.log(
    '  worktree squash <sid> [--target <branch>] [--message <text>] [--json|--format <fmt>]',
  );
  console.log('                               Worktree and git-step operator controls');
  console.log('  workflow validate <file> [--json]');
  console.log(
    '  workflow run <workflow-id|file> [--path <repo>] [--input k=v] [--input-json k=json] [--json]',
  );
  console.log('  workflow runs [--json]');
  console.log('  workflow show <run-id> [--json]');
  console.log('  workflow rerun <run-id> [--detach] [--json]');
  console.log('  workflow approve <run-id> <node-id> [--deny] [--message <text>] [--json]');
  console.log('  workflow cancel <run-id> [--message <text>] [--json]');
  console.log(
    '                               Validate, run, inspect, approve, and cancel local workflows',
  );
  console.log('  config resolve [--cwd <path>] [--json]');
  console.log('                               Resolve repo-local .viewport/config resources');
  console.log('  validate [--path <path>] [--json]');
  console.log('                               Validate repo-local .viewport/config.yaml contract');
  console.log('  contract resolve [--path <path>] [--json]');
  console.log('                               Resolve repo-local contract manifest');
  console.log('  guard check --path <file> [--action edit] [--cwd <repo>] [--json]');
  console.log('                               Check repo-local approval/risk gates');
  console.log('  skills install [claude-code|cursor|all] [--target <path>] [--force] [--json]');
  console.log('                               Install agent instructions for calling vpd');
  console.log(
    '  context init --context <id> --user <name> --device <name> --passphrase <text> --recovery-code <text> [--key-store file|macos-keychain] [--json]',
  );
  console.log(
    '                               Defaults to file; use macos-keychain explicitly on Darwin',
  );
  console.log(
    '  context user-init --user <name> --device <name> --passphrase <text> --recovery-code <text> [--key-store file|macos-keychain] [--json]',
  );
  console.log(
    '  context join --context <id> --user <name> --device <name> --passphrase <text> --recovery-code <text> [--key-store file|macos-keychain] [--json]',
  );
  console.log('  context status [--context <id>] [--json]');
  console.log(
    '  context add (--context <id>|--provider <id> --path <repo>) --device <name> --title <text> --body <text> --passphrase <text> --recovery-code <text> [--json]',
  );
  console.log(
    '  context propose --context <id> --device <name> --title <text> --body <text> --passphrase <text> --recovery-code <text> [--json]',
  );
  console.log(
    '  context resolve --context <id> --query <text> --passphrase <text> --recovery-code <text> [--json]',
  );
  console.log(
    '                               Resolve encrypted local context on this trusted edge',
  );
  console.log(
    '  context sync-push [--context <id>] [--server-url <url>] [--credential <token>] [--json]',
  );
  console.log(
    '                               Push signed encrypted context events to Viewport; defaults to vpd remote login config',
  );
  console.log(
    '  context sync-pull [--context <id>] [--server-url <url>] [--credential <token>] --passphrase <text> --recovery-code <text> [--json]',
  );
  console.log(
    '                               Pull signed encrypted context events from Viewport; defaults to vpd remote login config',
  );
  console.log(
    '  context identity-publish --name <identity> [--workspace <id>] [--server-url <url>] [--credential <token>] [--json]',
  );
  console.log(
    '                               Publish this trusted edge public identity for grant recipients',
  );
  console.log(
    '  context grants-process --context <id> --actor <device> --passphrase <text> --recovery-code <text> [--json]',
  );
  console.log(
    '                               Emit encrypted repo-key grant events for pending workspace shares',
  );
  console.log('  context identity-export --name <identity> [--out <path>] [--json]');
  console.log('  context identity-import (--identity <json>|--identity-file <path>) [--json]');
  console.log('  context device-request --device <name> --code <code> [--out <path>] [--json]');
  console.log(
    '  context device-approve --user <name> (--request <json>|--request-file <path>) --code <code> --passphrase <text> --recovery-code <text> [--out <path>] [--json]',
  );
  console.log(
    '  context device-accept --user <name> --device <name> (--approval <json>|--approval-file <path>) --code <code> [--json]',
  );
  console.log(
    '  context grant --context <id> --actor <device> --recipient <user> --passphrase <text> --recovery-code <text> [--json]',
  );
  console.log('  hook notify --event <EventName>');
  console.log('  hook plan                    Send a plan proposal hook from stdin');
  console.log('  hook capabilities [--adapter <name>] [--json]');
  console.log('  pair [<code>] [--server <url>] [--app-url <url>] [--json]');
  console.log('                               Pair with Viewport via pairing code');
  console.log('  pair anchor [--json]         Show daemon trust anchor fingerprint');
  console.log('  pair rotate-token [--json]   Rotate auth token on disk (restart required)');
  console.log('  update [--json] [--yes]      Update daemon package, optionally restart');
  console.log('  service <install|uninstall|status> [--json]');
  console.log('                               Manage OS user service (launchd/systemd)');
  console.log(
    '  remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <issue-token>]',
  );
  console.log('                               Configure daemon-native relay transport');
  console.log('  help                         Show this help message');
  console.log('');
  console.log('Agents are auto-detected from the built-in registry.');
  console.log('Directories are auto-discovered from agent storage on startup.');
}
