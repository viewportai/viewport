import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { hasFlag, getArgs } from './args.js';
import { configDir } from '../core/config.js';
import { install } from './install-command.js';
import { assessAgentPrerequisites, installPrerequisites } from '../startup-prereqs.js';
import { currentServicePlatform, installUserService } from './service-commands.js';

const SETUP_STATE_FILE = 'setup-state.json';
const PROMPT_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_TOKEN = '__VPD_SETUP_TIMEOUT__';

export interface SetupPlan {
  recommended: boolean;
  installService: boolean;
  installPrereqs: boolean;
  installHooks: boolean;
}

interface SetupState {
  completedAt: string;
  plan: SetupPlan;
}

export function recommendedSetupPlan(): SetupPlan {
  return {
    recommended: true,
    installService: true,
    installPrereqs: true,
    installHooks: true,
  };
}

export function applySetupFlagOverrides(plan: SetupPlan, args = getArgs()): SetupPlan {
  const updated = { ...plan };
  if (args.includes('--no-service')) updated.installService = false;
  if (args.includes('--no-prereqs')) updated.installPrereqs = false;
  if (args.includes('--no-hooks')) updated.installHooks = false;
  return updated;
}

function setupStatePath(): string {
  return path.join(configDir(), SETUP_STATE_FILE);
}

async function saveSetupState(plan: SetupPlan): Promise<void> {
  const state: SetupState = {
    completedAt: new Date().toISOString(),
    plan,
  };
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(setupStatePath(), JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await Promise.race([
      rl.question(question),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(PROMPT_TIMEOUT_TOKEN), PROMPT_TIMEOUT_MS),
      ),
    ]);
    if (answer === PROMPT_TIMEOUT_TOKEN) return defaultYes;
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return defaultYes;
    if (normalized === 'y' || normalized === 'yes') return true;
    if (normalized === 'n' || normalized === 'no') return false;
    return defaultYes;
  } finally {
    rl.close();
  }
}

export function resolveInstallUserForLinger(env: NodeJS.ProcessEnv = process.env): string | null {
  const sudoUser = env['SUDO_USER']?.trim();
  if (sudoUser) return sudoUser;
  const user = env['USER']?.trim();
  if (user) return user;
  return null;
}

export function parseLingerValue(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'yes') return true;
  if (normalized === 'no') return false;
  return null;
}

function hasCommand(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return result.status === 0;
}

function linuxLingerEnabled(user: string): boolean | null {
  const result = spawnSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  return parseLingerValue(result.stdout);
}

async function maybeOfferLinuxLingerEnable(
  interactive: boolean,
  warnings: string[],
): Promise<void> {
  if (process.platform !== 'linux') return;
  if (!hasCommand('loginctl')) return;

  const installUser = resolveInstallUserForLinger();
  if (!installUser) {
    warnings.push('Unable to determine install user for loginctl linger check.');
    return;
  }

  const linger = linuxLingerEnabled(installUser);
  if (linger === true) return;

  if (!interactive) {
    warnings.push(
      `For Linux VPS reboot persistence, run: sudo loginctl enable-linger ${installUser}`,
    );
    return;
  }

  const shouldEnable = await promptYesNo(
    `Enable Linux user linger for "${installUser}" so the daemon auto-starts after reboot? This runs: sudo loginctl enable-linger ${installUser} [Y/n] `,
    true,
  );
  if (!shouldEnable) {
    warnings.push(
      `Linger skipped by choice. For reboot persistence, run: sudo loginctl enable-linger ${installUser}`,
    );
    return;
  }

  const result = spawnSync('sudo', ['loginctl', 'enable-linger', installUser], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    warnings.push(
      `Could not enable linger automatically. Run manually: sudo loginctl enable-linger ${installUser}`,
    );
    return;
  }

  console.log(`Enabled linger for user "${installUser}".`);
}

async function chooseCustomPlan(): Promise<SetupPlan> {
  const installService = await promptYesNo(
    '\nInstall daemon as an OS boot service (launchd/systemd user service)? [Y/n] ',
    true,
  );
  const installPrereqsChoice = await promptYesNo(
    'Auto-install detected missing Claude/Codex SDK prerequisites? [Y/n] ',
    true,
  );
  const installHooks = await promptYesNo('Install agent hooks now (vpd install)? [Y/n] ', true);
  return {
    recommended: false,
    installService,
    installPrereqs: installPrereqsChoice,
    installHooks,
  };
}

export async function setup(): Promise<void> {
  if (hasFlag('json')) {
    throw new Error('`vpd setup --json` is not supported. Run interactive setup without --json.');
  }

  const forceRecommended = hasFlag('yes') || hasFlag('recommended');
  const forceCustom = hasFlag('choose');
  if (forceRecommended && forceCustom) {
    throw new Error('Cannot combine --yes/--recommended with --choose.');
  }

  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (forceCustom && !interactive) {
    throw new Error('`--choose` requires an interactive terminal.');
  }

  let plan: SetupPlan;
  if (forceRecommended) {
    plan = applySetupFlagOverrides(recommendedSetupPlan());
  } else if (forceCustom) {
    plan = await chooseCustomPlan();
  } else if (interactive) {
    const useRecommended = await promptYesNo(
      '\nFirst-time setup: proceed with recommended defaults (boot service + prerequisites + hooks)? [Y/n] ',
      true,
    );
    plan = useRecommended
      ? applySetupFlagOverrides(recommendedSetupPlan())
      : await chooseCustomPlan();
  } else {
    plan = applySetupFlagOverrides(recommendedSetupPlan());
  }

  const warnings: string[] = [];

  if (plan.installService) {
    const platform = currentServicePlatform();
    if (!platform) {
      warnings.push(
        `Service install skipped: unsupported platform ${process.platform} (supports darwin/linux).`,
      );
    } else {
      try {
        const result = await installUserService();
        console.log(
          `Service installed (${platform}): ${String(result['serviceFile'] ?? result['label'])}`,
        );
      } catch (err) {
        warnings.push(
          `Service install failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    console.log('Service install skipped by choice.');
  }

  if (plan.installService) {
    await maybeOfferLinuxLingerEnable(interactive, warnings);
  }

  const issues = await assessAgentPrerequisites();
  if (plan.installPrereqs) {
    const results = await installPrerequisites(issues);
    for (const result of results) {
      if (result.ok) {
        console.log(`Installed prerequisite: ${result.id}`);
      } else {
        warnings.push(`Prerequisite install failed (${result.id}): ${result.error ?? 'unknown'}`);
      }
    }
  } else if (issues.some((issue) => issue.autoInstall)) {
    warnings.push('Auto-install prerequisites skipped by choice.');
  }

  for (const issue of issues) {
    if (issue.autoInstall && plan.installPrereqs) continue;
    if (issue.hint) warnings.push(`${issue.id}: ${issue.hint}`);
  }

  if (plan.installHooks) {
    await install();
  } else {
    console.log('Hook install skipped by choice.');
  }

  await saveSetupState(plan);

  console.log('\nSetup complete.');
  if (warnings.length > 0) {
    console.log('\nFollow-up items:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}
