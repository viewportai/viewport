import { spawn } from 'node:child_process';
import { configDir } from '../core/config.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { resolveDaemonEndpoint } from './daemon-client.js';
import type { DaemonEndpoint } from './daemon-client.js';
import {
  clearDaemonRuntimeState,
  readDaemonRuntimeState,
  stopPid,
  DEFAULT_STOP_TIMEOUT_MS,
  waitForPidExit,
  readProcessInfo,
  isOwnershipMatch,
  isPidRunning,
} from './daemon-lifecycle.js';
import {
  compareSemver,
  fetchLatestVersion,
  formatNpmInvocation,
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
  type NpmInvocation,
} from './runtime-toolchain.js';
import { start } from '../startup.js';
import {
  isJsonMode,
  parseTimeoutMs,
  printJson,
  readDaemonHealth,
  requestLifecycle,
  resolvePackageName,
  resolvePackageVersion,
  shortError,
} from './command-shared.js';
import {
  createPairingClientIdentity,
  createPairingRedeemProof,
  getOrCreateTrustAnchor,
  issuePairingOffer,
  listPairingOffers,
  revokePairingOffer,
  rotateAuthToken,
} from '../server/pairing-offers.js';

function endpointHealthUrl(endpoint: DaemonEndpoint): string {
  if (endpoint.type === 'socket') {
    return `unix://${endpoint.socketPath}:/health`;
  }
  return `${endpoint.baseUrl}/health`;
}

function endpointListenLabel(endpoint: DaemonEndpoint): string {
  if (endpoint.type === 'socket') {
    return `unix://${endpoint.socketPath}`;
  }
  return `${endpoint.host}:${endpoint.port}`;
}

export async function status(): Promise<void> {
  const asJson = isJsonMode();
  const endpoint = await resolveDaemonEndpoint();
  const url = endpointHealthUrl(endpoint);
  const state = await readDaemonRuntimeState();
  const runningByState = !!(state && isPidRunning(state.ownerPid));
  const health = await readDaemonHealth();

  const statusValue: 'running' | 'stopped' | 'unresponsive' = health
    ? 'running'
    : runningByState
      ? 'unresponsive'
      : 'stopped';

  const owner =
    state?.ownerUid !== undefined
      ? `${state.ownerUid}@${state.ownerHostname ?? 'unknown-host'}`
      : null;
  const resolvedNode = resolvePreferredNodePath({
    daemonPid: state?.ownerPid ?? null,
    fallbackNodePath: process.execPath,
  });

  let runtimeNpm = 'unknown';
  let npmInvocation: NpmInvocation | null = null;
  try {
    npmInvocation = resolveNpmInvocationFromNode(resolvedNode.nodePath);
    runtimeNpm = formatNpmInvocation(npmInvocation);
  } catch (err) {
    runtimeNpm = `unresolved (${shortError(err)})`;
  }

  const cliVersion = resolvePackageVersion();
  let latestCliVersion = 'unknown';
  let updateStatus = 'unknown';
  let note: string | undefined;
  if (npmInvocation) {
    const latest = fetchLatestVersion({ npm: npmInvocation, packageName: resolvePackageName() });
    if (latest.version) {
      latestCliVersion = latest.version;
      const comparison = compareSemver(cliVersion, latest.version);
      if (comparison === null) {
        updateStatus = 'unknown (version format not comparable)';
      } else if (comparison < 0) {
        updateStatus = `update available (${cliVersion} -> ${latest.version})`;
      } else {
        updateStatus = 'up to date';
      }
    } else {
      note = latest.note;
      updateStatus = latest.note ?? 'unknown';
    }
  }

  const payload = {
    status: statusValue,
    endpoint: url,
    home: configDir(),
    ownerPid: state?.ownerPid ?? null,
    workerPid: state?.workerPid ?? health?.pid ?? null,
    owner,
    listen: state?.listen ?? health?.listen ?? endpointListenLabel(endpoint),
    socketPath:
      state?.socketPath ??
      health?.socketPath ??
      (endpoint.type === 'socket' ? endpoint.socketPath : null),
    startedAt: state?.startedAt ?? health?.startedAt ?? null,
    profile: state?.profile ?? null,
    runtimeNode: `${resolvedNode.nodePath} (${resolvedNode.source})`,
    runtimeNpm,
    cliVersion,
    latestCliVersion,
    updateStatus,
    health,
    note,
  };

  if (asJson) {
    printJson(payload);
    return;
  }

  console.log(`Status:      ${payload.status}`);
  console.log(`Home:        ${payload.home}`);
  console.log(`Listen:      ${payload.listen}`);
  if (payload.socketPath) {
    console.log(`Socket:      ${payload.socketPath}`);
  }
  console.log(`Owner PID:   ${payload.ownerPid ?? '-'}`);
  console.log(`Worker PID:  ${payload.workerPid ?? '-'}`);
  console.log(`Owner:       ${payload.owner ?? '-'}`);
  console.log(
    `Started:     ${payload.startedAt ? new Date(payload.startedAt).toISOString() : '-'}`,
  );
  console.log(`Profile:     ${payload.profile ?? '-'}`);
  console.log(`Node:        ${payload.runtimeNode}`);
  console.log(`npm:         ${payload.runtimeNpm}`);
  console.log(`CLI:         ${payload.cliVersion}`);
  console.log(`Latest CLI:  ${payload.latestCliVersion}`);
  console.log(`Update:      ${payload.updateStatus}`);
  if (payload.health) {
    console.log(`Sessions:    ${payload.health.sessions}`);
    console.log(`Directories: ${payload.health.directories}`);
    console.log(`Agents:      ${payload.health.agents}`);
  }
  if (payload.note) {
    console.log(`Note:        ${payload.note}`);
  }
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
  if (asJson) {
    await stop({ exitOnNotRunning: false, silent: true });
    await start({ silent: true });
    printJson({ command: 'restart', ok: true });
    return;
  }

  await stop({ exitOnNotRunning: false });
  await start();
}

export async function pair(): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const pairCommandIndex = args[0] === 'daemon' && args[1] === 'pair' ? 1 : 0;
  const pairSubcommand = args[pairCommandIndex + 1];

  if (pairSubcommand === 'list') {
    const offers = await listPairingOffers();
    if (asJson) {
      printJson({ command: 'pair list', ok: true, offers });
      return;
    }
    if (offers.length === 0) {
      console.log('No pairing offers found.');
      return;
    }
    console.log('Pairing offers\\n');
    for (const offer of offers) {
      const status = offer.active ? 'active' : offer.expired ? 'expired' : 'inactive';
      console.log(`${offer.offerId} (${status})`);
      console.log(`  listen:     ${offer.listen}`);
      console.log(`  profile:    ${offer.profile}`);
      console.log(`  trust:      ${offer.trustAnchor}`);
      console.log(`  daemon:     ${offer.daemonDeviceId}`);
      console.log(`  created:    ${new Date(offer.createdAt).toISOString()}`);
      console.log(`  expires:    ${new Date(offer.expiresAt).toISOString()}`);
      console.log('');
    }
    return;
  }

  if (pairSubcommand === 'revoke') {
    const offerId = args[pairCommandIndex + 2];
    if (!offerId || offerId.startsWith('--')) {
      throw new Error('Usage: vpd pair revoke <offer-id> [--json]');
    }
    const revoked = await revokePairingOffer(offerId);
    if (asJson) {
      printJson({ command: 'pair revoke', ok: revoked, offerId });
      return;
    }
    if (!revoked) {
      throw new Error(`Pair offer not found: ${offerId}`);
    }
    console.log(`Revoked pair offer ${offerId}`);
    return;
  }

  if (pairSubcommand === 'rotate-token') {
    const result = await rotateAuthToken();
    if (asJson) {
      printJson({
        command: 'pair rotate-token',
        ok: true,
        previousTokenExisted: result.previousTokenExisted,
        restarted: false,
      });
      return;
    }
    console.log('Rotated daemon auth token on disk.');
    console.log('Restart the daemon for the new token to take effect.');
    return;
  }

  if (pairSubcommand === 'anchor') {
    const anchor = await getOrCreateTrustAnchor();
    if (asJson) {
      printJson({
        command: 'pair anchor',
        ok: true,
        trustAnchor: anchor.fingerprint,
        trustAnchorId: anchor.id,
        createdAt: anchor.createdAt,
      });
      return;
    }
    console.log(`Trust anchor: ${anchor.fingerprint}`);
    console.log(`Anchor ID:    ${anchor.id}`);
    console.log(`Created:      ${new Date(anchor.createdAt).toISOString()}`);
    return;
  }

  const state = await readDaemonRuntimeState();
  const health = await readDaemonHealth();
  const endpoint = await resolveDaemonEndpoint();

  if (!state && !health) {
    if (asJson) {
      printJson({ command: 'pair', ok: false, error: 'Daemon is not running' });
      return;
    }
    console.error('Daemon is not running. Start it first with `vpd start`.');
    process.exit(1);
  }

  const defaultHost = endpoint.type === 'tcp' ? endpoint.host : '127.0.0.1';
  const defaultPort = endpoint.type === 'tcp' ? endpoint.port : 0;
  const ttlRaw = getFlag('ttl');
  const ttlSeconds = ttlRaw ? Number(ttlRaw) : 600;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`Invalid --ttl value: ${ttlRaw}`);
  }
  const issued = await issuePairingOffer({
    ttlSeconds,
    connection: {
      host: state?.host ?? health?.host ?? defaultHost,
      port: state?.port ?? health?.port ?? defaultPort,
      listen: state?.listen ?? health?.listen ?? endpointListenLabel(endpoint),
      socketPath:
        state?.socketPath ??
        health?.socketPath ??
        (endpoint.type === 'socket' ? endpoint.socketPath : undefined),
      profile: state?.profile ?? 'local',
    },
  });
  const offer = {
    offerId: issued.offerId,
    redeemSecret: issued.redeemSecret,
    trustAnchor: issued.trustAnchor,
    daemonDeviceId: issued.daemonDeviceId,
    daemonPublicKey: issued.daemonPublicKey,
    host: state?.host ?? health?.host ?? defaultHost,
    port: state?.port ?? health?.port ?? defaultPort,
    listen: state?.listen ?? health?.listen ?? endpointListenLabel(endpoint),
    socketPath:
      state?.socketPath ??
      health?.socketPath ??
      (endpoint.type === 'socket' ? endpoint.socketPath : undefined),
    profile: state?.profile ?? 'local',
    createdAt: issued.createdAt,
    expiresAt: issued.expiresAt,
  };

  const encoded = Buffer.from(
    JSON.stringify({
      offerId: offer.offerId,
      proof: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      daemonDeviceId: offer.daemonDeviceId,
      daemonPublicKey: offer.daemonPublicKey,
      host: offer.host,
      port: offer.port,
      listen: offer.listen,
      socketPath: offer.socketPath,
      profile: offer.profile,
      createdAt: offer.createdAt,
      expiresAt: offer.expiresAt,
    }),
    'utf-8',
  ).toString('base64url');
  const url = `viewport://pair#offer=${encoded}`;

  if (asJson) {
    printJson({ command: 'pair', ok: true, offer, url });
    return;
  }

  // Print a redeem payload example with client proof generation for operators.
  const clientIdentity = createPairingClientIdentity();
  const proof = createPairingRedeemProof({
    offerId: offer.offerId,
    redeemSecret: offer.redeemSecret,
    trustAnchor: offer.trustAnchor,
    clientIdentity,
  });

  console.log('\nPairing offer:\n');
  console.log(url);
  console.log('\nRedeem payload preview (example):\n');
  console.log(
    JSON.stringify(
      {
        offerId: offer.offerId,
        proof: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey: proof.clientPublicKey,
        clientProof: proof.clientProof,
      },
      null,
      2,
    ),
  );
}

function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Command exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function update(): Promise<void> {
  const asJson = isJsonMode();
  const packageName = resolvePackageName();
  const state = await readDaemonRuntimeState();
  const resolvedNode = resolvePreferredNodePath({
    daemonPid: state?.ownerPid ?? null,
    fallbackNodePath: process.execPath,
  });
  const npm = resolveNpmInvocationFromNode(resolvedNode.nodePath);

  const exitCode = await runCommand(npm.command, [
    ...npm.argsPrefix,
    'install',
    '-g',
    `${packageName}@latest`,
  ]);
  if (exitCode !== 0) {
    if (asJson) {
      printJson({
        command: 'update',
        ok: false,
        error: `Update command failed with exit code ${exitCode}`,
      });
      return;
    }
    throw new Error(`Update command failed with exit code ${exitCode}`);
  }

  const shouldRestart = hasFlag('yes') || hasFlag('restart');
  if (shouldRestart) {
    await stop({ exitOnNotRunning: false });
    await start();
  }

  if (asJson) {
    printJson({
      command: 'update',
      ok: true,
      package: packageName,
      restarted: shouldRestart,
      runtimeNode: resolvedNode.nodePath,
      runtimeNpm: formatNpmInvocation(npm),
    });
    return;
  }

  if (!shouldRestart) {
    console.log('Update complete. Restart skipped. Run `vpd restart` when ready.');
    return;
  }
  console.log('Update complete. Daemon restart requested.');
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
    '  daemon <subcommand>          Lifecycle ops (start, status, stop, restart, pair, update, service, setup)',
  );
  console.log('  setup [--yes|--choose]       First-run guided setup (recommended or custom)');
  console.log('  install [--json]             Detect available agents and install hooks');
  console.log('  add <path> [--json]          Register a directory');
  console.log('  remove <path> [--json]       Unregister a directory');
  console.log('  list [--json]                List directories + active sessions');
  console.log('  status [--json]              Daemon health and runtime status');
  console.log('  stop [--json] [--timeout <seconds>] [--force]');
  console.log('                               Stop daemon gracefully (with optional forced kill)');
  console.log('  restart                       Stop then start daemon');
  console.log('  run [<dir>] --prompt <text>  Launch a session (auto-registers directory)');
  console.log(
    '  ls [--scope all|active|discovered] [--directory <id>] [--agent <id>] [--json|--format <fmt>]',
  );
  console.log('                               List active/discovered sessions');
  console.log('  session stop <sid> [--json|--format <fmt>]  Stop an active session');
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
  console.log('  pair [--ttl <seconds>] [--json]');
  console.log('                               Create a short-lived pairing offer URL');
  console.log('  pair list [--json]           List pairing offers');
  console.log('  pair revoke <offer-id> [--json]');
  console.log('                               Revoke a pairing offer');
  console.log('  pair anchor [--json]         Show daemon trust anchor fingerprint');
  console.log('  pair rotate-token [--json]   Rotate auth token on disk (restart required)');
  console.log('  update [--json] [--yes]      Update daemon package, optionally restart');
  console.log('  service <install|uninstall|status> [--json]');
  console.log('                               Manage OS user service (launchd/systemd)');
  console.log(
    '  remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <enroll-token>] [--user <id>]',
  );
  console.log('                               Configure daemon-native relay transport');
  console.log('  help                         Show this help message');
  console.log('');
  console.log('Agents are auto-detected from the built-in registry.');
  console.log('Directories are auto-discovered from agent storage on startup.');
}
