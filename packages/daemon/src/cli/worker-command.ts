import { ConfigManager } from '../core/config.js';
import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { runStandaloneWorker } from './worker-runtime.js';
import {
  defaultWorkerWorkspaceRoot,
  normalizeWorkerLifecycle,
  normalizeWorkerTransport,
  resetWorkerProfile,
} from './worker-profile.js';

export async function worker(): Promise<void> {
  const args = getArgs();
  const subcommand = args[1] ?? 'help';

  switch (subcommand) {
    case 'help':
    case '--help':
    case '-h':
      showWorkerHelp();
      return;
    case 'doctor':
      await workerDoctor();
      return;
    case 'reset':
      await workerReset();
      return;
    case 'start':
      await workerStart();
      return;
    case 'run-once':
      await workerRunOnce();
      return;
    default:
      throw new Error(`${workerHelpText()}\nUnknown worker command "${subcommand}".`);
  }
}

export function showWorkerHelp(): void {
  console.log(workerHelpText());
}

function workerHelpText(): string {
  return [
    'Usage: vpd worker <command>',
    '',
    'Commands:',
    '  start --mode persistent --transport polling|relay|inbound',
    '  run-once --lease <lease-token> --transport polling|relay|inbound',
    '  doctor [--json]',
    '  reset [--json]',
    '  help',
    '',
    'Pairing:',
    '  vpd pair --worker --transport=polling',
    '  vpd pair --worker --server <url> --transport=polling',
    '',
    'Defaults:',
    `  workspace root: ${defaultWorkerWorkspaceRoot()}`,
    '  server: hosted Viewport unless --server or config overrides it',
  ].join('\n');
}

async function workerDoctor(): Promise<void> {
  const asJson = isJsonMode();
  const manager = new ConfigManager();
  await manager.load();
  const workerConfig = manager.getDaemonConfig()?.worker;
  const missing: string[] = [];
  if (!workerConfig?.serverUrl) missing.push('server URL');
  if (!workerConfig?.workspaceRoot) missing.push('workspace root');
  if (!workerConfig?.identityKeyPath || !workerConfig.publicKeyFingerprint) {
    missing.push('worker identity');
  }
  const payload = {
    command: 'worker doctor',
    ok: missing.length === 0,
    lifecycle: workerConfig?.lifecycle ?? null,
    transport: workerConfig?.transport ?? null,
    serverUrl: workerConfig?.serverUrl ?? null,
    workspaceRoot: workerConfig?.workspaceRoot ?? null,
    publicKeyFingerprint: workerConfig?.publicKeyFingerprint ?? null,
    capabilities: workerConfig?.capabilities ?? null,
    missing,
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log('Viewport worker doctor');
  console.log(`Mode:      ${payload.lifecycle ?? 'not configured'}`);
  console.log(`Transport: ${payload.transport ?? 'not configured'}`);
  console.log(`Server:    ${payload.serverUrl ?? 'not configured'}`);
  console.log(`Work root: ${payload.workspaceRoot ?? 'not configured'}`);
  const agents = payload.capabilities?.agents;
  const agentCount = Array.isArray(agents)
    ? agents.length
    : agents && typeof agents === 'object'
      ? Object.keys(agents).length
      : 0;
  console.log(`Agents:    ${agentCount > 0 ? `${agentCount} detected` : 'not recorded'}`);
  if (missing.length > 0) {
    console.log(`Missing:   ${missing.join(', ')}`);
    console.log('Fix:       run `vpd pair --worker --transport=polling`.');
    return;
  }
  console.log('Status:    configured');
}

async function workerReset(): Promise<void> {
  const asJson = isJsonMode();
  const result = await resetWorkerProfile();
  if (asJson) {
    printJson({ command: 'worker reset', ok: true, ...result });
    return;
  }
  if (!result.hadWorkerProfile) {
    console.log('No worker profile was configured.');
    return;
  }
  console.log('Worker pairing reset.');
  console.log('Run `vpd pair --worker --transport=polling` to pair this worker again.');
}

async function workerStart(): Promise<void> {
  const asJson = isJsonMode();
  const lifecycle = normalizeWorkerLifecycle(getFlag('mode') ?? getFlag('lifecycle'));
  if (lifecycle !== 'persistent') {
    throw new Error('Use `vpd worker run-once` for ephemeral workers.');
  }
  const result = await runStandaloneWorker({
    lifecycle,
    transport: normalizeWorkerTransport(getFlag('transport')),
    once: getArgs().includes('--once'),
  });
  if (asJson) {
    printJson({ command: 'worker start', ok: true, ...result });
    return;
  }
  console.log(
    `Worker stopped. Claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}, cleanup ${result.cleanup}.`,
  );
}

async function workerRunOnce(): Promise<void> {
  const asJson = isJsonMode();
  const lease = getFlag('lease');
  if (!lease || lease.trim() === '') {
    throw new Error(
      'Usage: vpd worker run-once --lease <lease-token> [--transport polling|relay|inbound]',
    );
  }
  const result = await runStandaloneWorker({
    lifecycle: 'ephemeral',
    transport: normalizeWorkerTransport(getFlag('transport')),
    once: true,
    leaseToken: lease.trim(),
  });
  if (asJson) {
    printJson({ command: 'worker run-once', ok: true, ...result });
    return;
  }
  console.log(`Worker run-once complete. Cleanup receipts: ${result.cleanup}.`);
}
