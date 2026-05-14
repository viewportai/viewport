import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeProfileInfo,
  normalizeProfileName,
  readProfileRegistry,
  resolveViewportBaseHome,
} from '../core/profiles.js';
import { getArgs } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { isPidRunning } from './daemon-lifecycle.js';

export async function profileProcesses(): Promise<void> {
  const asJson = isJsonMode();
  const baseHome = resolveViewportBaseHome();
  const registry = await readProfileRegistry(baseHome);
  const active = activeProfileInfo();
  const profiles = Object.values(registry.profiles).sort((a, b) => a.name.localeCompare(b.name));
  const rows = await Promise.all(
    profiles.map(async (profile) => {
      const state = await readProfileRuntimeState(profile.home);
      const running = typeof state?.ownerPid === 'number' ? isPidRunning(state.ownerPid) : false;
      return {
        profile: profile.name,
        active: active.name === profile.name,
        running,
        ownerPid: state?.ownerPid ?? null,
        workerPid: state?.workerPid ?? null,
        listen: state?.listen ?? null,
        home: profile.home,
      };
    }),
  );
  const payload = {
    command: 'profile ps',
    ok: true,
    active,
    profiles: rows,
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  if (rows.length === 0) {
    console.log('No profiles yet.');
    return;
  }
  for (const row of rows) {
    const marker = row.active ? '*' : ' ';
    const state = row.running ? `running owner=${row.ownerPid}` : 'stopped';
    console.log(`${marker} ${row.profile}\t${state}\t${row.listen ?? '-'}`);
  }
}

export function printProfileEnvironment(): void {
  const name = readProfileNameArg(2, 'Usage: vpd profile env <name>');
  console.log(`export VPD_PROFILE=${shellQuote(name)}`);
}

export async function execProfileCommand(): Promise<void> {
  const args = getArgs();
  const name = readProfileNameArg(2, 'Usage: vpd profile exec <name> -- <command...>');
  const separator = args.indexOf('--');
  if (separator === -1 || separator + 1 >= args.length) {
    throw new Error('Usage: vpd profile exec <name> -- <command...>');
  }
  const command = args[separator + 1];
  if (!command) throw new Error('Usage: vpd profile exec <name> -- <command...>');
  const commandArgs = args.slice(separator + 2);
  const code = await runExternalCommand(command, commandArgs, profileEnv(name));
  process.exit(code);
}

export async function runVpdProfileSubcommand(subcommand: string): Promise<void> {
  const args = getArgs();
  const name = readProfileNameArg(2, `Usage: vpd profile ${subcommand} <name> [flags...]`);
  const passthrough = args.slice(3);
  const code = await runCurrentVpd([subcommand, ...passthrough], profileEnv(name));
  process.exit(code);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readProfileNameArg(index: number, usage: string): string {
  const raw = getArgs()[index];
  if (!raw || raw.startsWith('--')) throw new Error(usage);
  return normalizeProfileName(raw);
}

function profileEnv(name: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VPD_PROFILE: name,
    VIEWPORT_PROFILE: name,
  };
}

function currentCliPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js');
}

async function runCurrentVpd(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return runExternalCommand(process.execPath, [currentCliPath(), ...args], env);
}

async function runExternalCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
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

async function readProfileRuntimeState(profileHome: string): Promise<{
  ownerPid?: number;
  workerPid?: number;
  listen?: string;
} | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(profileHome, 'daemon-state.json'), 'utf8'),
    ) as {
      ownerPid?: unknown;
      workerPid?: unknown;
      listen?: unknown;
      host?: unknown;
      port?: unknown;
    };
    const ownerPid = typeof parsed.ownerPid === 'number' ? parsed.ownerPid : undefined;
    const workerPid = typeof parsed.workerPid === 'number' ? parsed.workerPid : undefined;
    const listen =
      typeof parsed.listen === 'string'
        ? parsed.listen
        : typeof parsed.host === 'string' && typeof parsed.port === 'number'
          ? `${parsed.host}:${parsed.port}`
          : undefined;
    return { ownerPid, workerPid, listen };
  } catch {
    return null;
  }
}
