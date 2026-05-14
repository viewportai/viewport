import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePackageName } from '../core/package-meta.js';
import { readProfileRegistry, resolveViewportBaseHome } from '../core/profiles.js';
import { hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { currentServicePlatform, uninstallUserService } from './service-commands.js';
import {
  formatNpmInvocation,
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
} from './runtime-toolchain.js';

interface UninstallResult {
  command: string;
  ok: boolean;
  stoppedProfiles: Array<{ profile: string; exitCode: number }>;
  service: Record<string, unknown> | null;
  packageRemoved: boolean;
  purgedHome: string | null;
  runtimeNpm?: string;
}

export async function uninstall(): Promise<void> {
  const asJson = isJsonMode();
  const assumeYes = hasFlag('yes') || hasFlag('force');
  const removePackage = !hasFlag('no-package');
  const purgeHome = hasFlag('purge-home');

  if (!assumeYes && !process.stdin.isTTY) {
    throw new Error('Refusing non-interactive uninstall without --yes.');
  }

  const stoppedProfiles = await stopAllKnownProfiles();
  const service = await uninstallServiceIfPresent();
  let packageRemoved = false;
  let runtimeNpm: string | undefined;
  if (removePackage) {
    const npm = resolveNpmInvocationFromNode(
      resolvePreferredNodePath({ daemonPid: null, fallbackNodePath: process.execPath }).nodePath,
    );
    runtimeNpm = formatNpmInvocation(npm);
    const exitCode = await runCommand(npm.command, [
      ...npm.argsPrefix,
      'uninstall',
      '-g',
      resolvePackageName(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Package uninstall failed with exit code ${exitCode}.`);
    }
    packageRemoved = true;
  }

  let purgedHome: string | null = null;
  if (purgeHome) {
    purgedHome = resolveViewportBaseHome();
    await fs.rm(purgedHome, { recursive: true, force: true });
  }

  const payload: UninstallResult = {
    command: 'uninstall',
    ok: true,
    stoppedProfiles,
    service,
    packageRemoved,
    purgedHome,
    runtimeNpm,
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log('Viewport daemon uninstall complete.');
  console.log(`Stopped profiles: ${stoppedProfiles.length}`);
  console.log(`Service removed: ${service ? 'yes' : 'not installed or unsupported'}`);
  console.log(`Package removed: ${packageRemoved ? 'yes' : 'no (--no-package)'}`);
  if (purgedHome) console.log(`Purged home: ${purgedHome}`);
}

async function stopAllKnownProfiles(): Promise<Array<{ profile: string; exitCode: number }>> {
  const baseHome = resolveViewportBaseHome();
  const registry = await readProfileRegistry(baseHome);
  const profiles = Object.keys(registry.profiles);
  const targets = profiles.length > 0 ? profiles : ['default'];
  const stopped: Array<{ profile: string; exitCode: number }> = [];
  for (const profile of targets) {
    const env = {
      ...process.env,
      VPD_PROFILE: profile === 'default' ? '' : profile,
      VIEWPORT_PROFILE: profile === 'default' ? '' : profile,
    };
    const code = await runCurrentVpd(['stop', '--force', '--json'], env);
    stopped.push({ profile, exitCode: code });
  }
  return stopped;
}

async function uninstallServiceIfPresent(): Promise<Record<string, unknown> | null> {
  if (!currentServicePlatform()) return null;
  try {
    return await uninstallUserService();
  } catch {
    return null;
  }
}

function currentCliPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js');
}

async function runCurrentVpd(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return runCommand(process.execPath, [currentCliPath(), ...args], env, true);
}

function runCommand(
  command: string,
  args: string[],
  env = process.env,
  quiet = false,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: quiet ? 'ignore' : 'inherit',
      env,
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
