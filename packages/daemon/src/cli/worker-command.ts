import { ConfigManager } from '../core/config.js';
import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  defaultWorkerWorkspaceRoot,
  normalizeWorkerLifecycle,
  normalizeWorkerTransport,
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
  const agentCount = payload.capabilities?.agents?.length ?? 0;
  console.log(`Agents:    ${agentCount > 0 ? `${agentCount} detected` : 'not recorded'}`);
  if (missing.length > 0) {
    console.log(`Missing:   ${missing.join(', ')}`);
    console.log('Fix:       run `vpd pair --worker --transport=polling`.');
    return;
  }
  console.log('Status:    configured');
}

async function workerStart(): Promise<void> {
  const lifecycle = normalizeWorkerLifecycle(getFlag('mode') ?? getFlag('lifecycle'));
  if (lifecycle !== 'persistent') {
    throw new Error('Use `vpd worker run-once` for ephemeral workers.');
  }
  normalizeWorkerTransport(getFlag('transport'));
  throw new Error(
    'Standalone worker execution lands in runner Phase 8. Pair first with `vpd pair --worker --transport=polling`.',
  );
}

async function workerRunOnce(): Promise<void> {
  const lease = getFlag('lease');
  if (!lease || lease.trim() === '') {
    throw new Error('Usage: vpd worker run-once --lease <lease-token> [--transport polling|relay|inbound]');
  }
  normalizeWorkerTransport(getFlag('transport'));
  throw new Error('Standalone run-once execution lands in runner Phase 8.');
}
