import { spawn } from 'node:child_process';
import { hasFlag } from './args.js';
import { readDaemonRuntimeState } from './daemon-lifecycle.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  formatNpmInvocation,
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
} from './runtime-toolchain.js';
import { resolvePackageName } from '../core/package-meta.js';
import { restartDaemon } from './lifecycle-commands.js';

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
  const shouldRestart = hasFlag('yes') || hasFlag('restart');
  if (hasFlag('dry-run')) {
    const payload = {
      command: 'update',
      ok: true,
      dryRun: true,
      package: packageName,
      upgradePolicy: 'manual-package-manager',
      signedReleaseManifest: false,
      restartRequested: shouldRestart,
      commandPlan: ['npm', 'install', '-g', `${packageName}@latest`],
      note:
        'vpd update currently delegates to the package manager. Signed release manifests are not available yet.',
    };
    if (asJson) {
      printJson(payload);
      return;
    }
    console.log(`Update plan: ${payload.commandPlan.join(' ')}`);
    console.log(`Restart: ${shouldRestart ? 'requested after update' : 'skipped'}`);
    console.log(payload.note);
    return;
  }
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

  if (shouldRestart) {
    await restartDaemon();
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
