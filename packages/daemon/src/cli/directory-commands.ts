import path from 'node:path';
import fs from 'node:fs/promises';
import { Daemon } from '../core/daemon.js';
import { getArgs } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import type { DaemonDirectoryInfo } from './daemon-client.js';
import { isJsonMode, printJson, shortError } from './command-shared.js';

function displayNameForDirectory(dir: Pick<DaemonDirectoryInfo, 'id' | 'path'> & { name?: string }): string {
  const configuredName = typeof dir.name === 'string' ? dir.name.trim() : '';
  if (configuredName.length > 0) {
    return configuredName;
  }

  const normalized = dir.path.replace(/\/+$/, '');
  return path.basename(normalized) || normalized || dir.id;
}

export async function addDirectory(): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const dirPath = args[1];
  if (!dirPath) {
    if (asJson) {
      printJson({ command: 'add', ok: false, error: 'Usage: vpd add <path>' });
      return;
    }
    console.error('Usage: vpd add <path>');
    process.exit(1);
  }

  const resolved = path.resolve(dirPath);

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
  } catch (err) {
    if (asJson) {
      printJson({ command: 'add', ok: false, error: shortError(err), path: resolved });
      return;
    }
    console.error(shortError(err));
    process.exit(1);
  }

  if (await isDaemonRunning()) {
    const res = await daemonFetch('/api/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: resolved }),
    });

    if (res && res.ok) {
      const info = (await res.json()) as DaemonDirectoryInfo;
      if (asJson) {
        printJson({ command: 'add', ok: true, source: 'daemon', directory: info });
        return;
      }
      console.log(`Registered: ${resolved} (id: ${info.id})`);
      return;
    }
    if (res && !res.ok) {
      const body = (await res.json()) as { error?: string };
      if (asJson) {
        printJson({
          command: 'add',
          ok: false,
          source: 'daemon',
          error: body.error ?? res.statusText,
        });
        return;
      }
      console.error(`Failed: ${body.error ?? res.statusText}`);
      process.exit(1);
    }
  }

  const daemon = new Daemon();
  await daemon.initialize();
  const info = await daemon.directoryManager.register(resolved);
  if (asJson) {
    printJson({ command: 'add', ok: true, source: 'config', directory: info });
    return;
  }
  console.log(`Registered: ${info.path} (id: ${info.id})`);
  console.log('  (daemon not running — saved to config file)');
}

export async function removeDirectory(): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const dirPath = args[1];
  if (!dirPath) {
    if (asJson) {
      printJson({ command: 'remove', ok: false, error: 'Usage: vpd remove <path>' });
      return;
    }
    console.error('Usage: vpd remove <path>');
    process.exit(1);
  }

  const resolved = path.resolve(dirPath);

  if (await isDaemonRunning()) {
    const listRes = await daemonFetch('/api/directories');
    if (listRes && listRes.ok) {
      const dirs = (await listRes.json()) as DaemonDirectoryInfo[];
      const dir = dirs.find((d) => d.path === resolved);
      if (!dir) {
        if (asJson) {
          printJson({ command: 'remove', ok: false, error: `Not registered: ${resolved}` });
          return;
        }
        console.error(`Not registered: ${resolved}`);
        process.exit(1);
      }

      const res = await daemonFetch(`/api/directories/${dir.id}`, { method: 'DELETE' });
      if (res && (res.ok || res.status === 204)) {
        if (asJson) {
          printJson({
            command: 'remove',
            ok: true,
            source: 'daemon',
            directoryId: dir.id,
            path: resolved,
          });
          return;
        }
        console.log(`Unregistered: ${resolved}`);
        return;
      }
    }
  }

  const daemon = new Daemon();
  await daemon.initialize();
  const dir = daemon.directoryManager.getByPath(resolved);
  if (!dir) {
    if (asJson) {
      printJson({ command: 'remove', ok: false, error: `Not registered: ${resolved}` });
      return;
    }
    console.error(`Not registered: ${resolved}`);
    process.exit(1);
  }

  await daemon.directoryManager.unregister(dir.id);
  if (asJson) {
    printJson({
      command: 'remove',
      ok: true,
      source: 'config',
      directoryId: dir.id,
      path: resolved,
    });
    return;
  }
  console.log(`Unregistered: ${resolved}`);
  console.log('  (daemon not running — saved to config file)');
}

export async function list(): Promise<void> {
  const asJson = isJsonMode();
  if (await isDaemonRunning()) {
    const res = await daemonFetch('/api/directories');
    if (res && res.ok) {
      const dirs = (await res.json()) as DaemonDirectoryInfo[];
      if (asJson) {
        printJson({ command: 'list', source: 'daemon', directories: dirs });
        return;
      }
      if (dirs.length === 0) {
        console.log('No directories registered.');
        console.log('Directories are auto-discovered from agent storage on daemon start.');
        return;
      }

      console.log('Registered directories:\n');
      for (const dir of dirs) {
        const sessions = dir.activeSessions?.length ?? 0;
        console.log(`  ${displayNameForDirectory(dir)}`);
        console.log(`    path:     ${dir.path}`);
        console.log(`    id:       ${dir.id}`);
        console.log(`    sessions: ${sessions} active`);
        console.log('');
      }
      return;
    }
  }

  const daemon = new Daemon();
  await daemon.initialize();
  const dirs = daemon.directoryManager.list();
  if (asJson) {
    printJson({ command: 'list', source: 'config', directories: dirs });
    return;
  }
  if (dirs.length === 0) {
    console.log('No directories registered.');
    console.log('Start the daemon with "vpd start" to auto-discover directories.');
    return;
  }

  console.log('Registered directories (from config file):\n');
  for (const dir of dirs) {
    const name = displayNameForDirectory(dir);
    console.log(`  ${name}`);
    console.log(`    path: ${dir.path}`);
    console.log(`    id:   ${dir.id}`);
    console.log('');
  }
}
