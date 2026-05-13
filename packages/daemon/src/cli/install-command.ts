import path from 'node:path';
import fs from 'node:fs/promises';
import { AgentRegistry } from '../core/agent-registry.js';
import { ConfigManager, configDir } from '../core/config.js';
import { getDaemonPort, getFlag } from './args.js';
import { BUILT_IN_AGENTS } from '../agents/built-in.js';
import { ClaudeHookInstaller, HOOK_EVENT_KINDS } from '../hooks/index.js';
import type { HookInstaller } from '../hooks/index.js';
import { isJsonMode, printJson, shortError } from './command-shared.js';
import { readDaemonRuntimeState } from './daemon-lifecycle.js';
import { parseListenTarget } from './listen-target.js';

/** Hook installers for each supported agent. */
const HOOK_INSTALLERS: HookInstaller[] = [new ClaudeHookInstaller()];

/**
 * Resolve the path used in hook commands.
 * In production: `vpd` (global binary).
 * In dev: `npx tsx /absolute/path/to/src/index.ts` so hooks work without a global install.
 */
function resolveVpdPath(): string {
  const arg1 = process.argv[1] ?? 'vpd';

  if (arg1.endsWith('.ts')) {
    const abs = path.resolve(arg1);
    return `npx tsx ${abs}`;
  }

  return arg1;
}

async function resolveHookDaemonListen(): Promise<string> {
  const explicitListen = getFlag('listen');
  if (explicitListen) {
    return parseListenTarget(explicitListen).listen;
  }

  const explicitPort = getFlag('port');
  if (explicitPort) {
    const host = getFlag('host') ?? '127.0.0.1';
    return parseListenTarget(`${host}:${explicitPort}`).listen;
  }

  const runtimeState = await readDaemonRuntimeState();
  if (runtimeState?.listen) {
    return runtimeState.listen;
  }

  const manager = new ConfigManager();
  await manager.load();
  const configuredListen = manager.getDaemonConfig()?.listen;
  if (configuredListen) {
    return parseListenTarget(configuredListen).listen;
  }

  return parseListenTarget(`${getFlag('host') ?? '127.0.0.1'}:${getDaemonPort()}`).listen;
}

export async function install(): Promise<void> {
  const asJson = isJsonMode();

  const registry = new AgentRegistry();
  for (const def of BUILT_IN_AGENTS) {
    registry.register(def);
  }

  const availability = await registry.detectAvailable();

  const vpdPath = resolveVpdPath();
  const daemonListen = await resolveHookDaemonListen();

  const hookResults: Array<{
    adapter: string;
    status: 'installed' | 'up-to-date' | 'failed';
    error?: string;
  }> = [];

  for (const installer of HOOK_INSTALLERS) {
    try {
      const changed = await installer.install({
        vpdBinaryPath: vpdPath,
        daemonListen,
        events: [...HOOK_EVENT_KINDS],
      });
      hookResults.push({
        adapter: installer.adapterName,
        status: changed ? 'installed' : 'up-to-date',
      });
    } catch (err) {
      hookResults.push({
        adapter: installer.adapterName,
        status: 'failed',
        error: shortError(err),
      });
    }
  }

  const dir = configDir();
  await fs.mkdir(dir, { recursive: true });

  if (asJson) {
    printJson({
      command: 'install',
      configPath: `${dir}/config.json`,
      agents: registry.getAll().map((def) => ({
        id: def.id,
        displayName: def.displayName,
        available: availability.get(def.id) ?? false,
        detection: def.detection.description,
      })),
      hooks: hookResults,
      daemonListen,
    });
    return;
  }

  console.log('Viewport daemon — agent detection\n');
  console.log('Detected agents:\n');
  for (const def of registry.getAll()) {
    const available = availability.get(def.id) ?? false;
    const status = available ? 'found' : 'not found';
    const icon = available ? '+' : '-';
    console.log(`  [${icon}] ${def.displayName} (${def.tier}): ${status}`);
    console.log(`      ${def.detection.description}`);
  }

  console.log('\nInstalling hooks:\n');
  for (const result of hookResults) {
    if (result.status === 'failed') {
      console.log(`  [-] ${result.adapter}: failed (${result.error ?? 'unknown'})`);
      continue;
    }
    const label = result.status === 'installed' ? 'installed' : 'already up to date';
    console.log(`  [+] ${result.adapter}: ${label}`);
  }

  console.log(`\nViewport config: ${dir}/config.json`);
  console.log('\nRun "vpd start" to start the daemon.');
}
