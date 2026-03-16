import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Dirent } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from './core/output.js';
import { loadConfig, BUILT_IN_DEFAULTS } from './core/config.js';
import { claudeProjectsDir } from './discovery/jsonl-reader.js';
import { codexSessionsDir } from './discovery/codex.js';
import { resolveNpmInvocationFromNode } from './cli/runtime-toolchain.js';
import { CODEX_SDK_PACKAGE_CANDIDATES, isCodexSdkAvailable } from './adapters/codex-sdk-loader.js';
import { commandExists } from './agents/command-detection.js';

const CLAUDE_SDK_PACKAGE_CANDIDATES = ['@anthropic-ai/claude-agent-sdk'] as const;
const PROMPT_TIMEOUT_MS = 15_000;
const TIMED_OUT_TOKEN = '__VPD_INSTALL_PROMPT_TIMEOUT__';

interface PrereqSnapshot {
  preferredAgents: Set<string>;
  hasClaudeSessions: boolean;
  hasCodexSessions: boolean;
  claudeSdkInstalled: boolean;
  codexSdkInstalled: boolean;
  geminiCliInstalled: boolean;
}

export interface PrereqIssue {
  id: 'claude-sdk' | 'codex-sdk' | 'gemini-cli';
  autoInstall: boolean;
  prompt: string;
  packages?: readonly string[];
  hint?: string;
}

export interface PrereqInstallResult {
  id: PrereqIssue['id'];
  ok: boolean;
  error?: string;
}

export function detectPrereqIssues(snapshot: PrereqSnapshot): PrereqIssue[] {
  const issues: PrereqIssue[] = [];
  const wantsClaude =
    snapshot.preferredAgents.has('claude') ||
    snapshot.hasClaudeSessions ||
    snapshot.preferredAgents.size === 0;
  const wantsCodex = snapshot.preferredAgents.has('codex') || snapshot.hasCodexSessions;
  const wantsGemini = snapshot.preferredAgents.has('gemini');

  if (wantsClaude && !snapshot.claudeSdkInstalled) {
    issues.push({
      id: 'claude-sdk',
      autoInstall: true,
      prompt:
        '\nClaude is configured or existing Claude sessions were detected, but @anthropic-ai/claude-agent-sdk is missing.\nInstall it now so daemon can launch/resume Claude sessions? [Y/n] ',
      packages: CLAUDE_SDK_PACKAGE_CANDIDATES,
      hint: 'npm install @anthropic-ai/claude-agent-sdk@latest',
    });
  }

  if (wantsCodex && !snapshot.codexSdkInstalled) {
    issues.push({
      id: 'codex-sdk',
      autoInstall: true,
      prompt:
        '\nCodex is configured or existing Codex sessions were detected, but @openai/codex-sdk is missing.\nInstall it now so daemon can launch/resume Codex sessions? [Y/n] ',
      packages: CODEX_SDK_PACKAGE_CANDIDATES,
      hint: 'npm install @openai/codex-sdk@latest',
    });
  }

  if (wantsGemini && !snapshot.geminiCliInstalled) {
    issues.push({
      id: 'gemini-cli',
      autoInstall: false,
      prompt:
        '\nGemini is configured, but the `gemini` CLI is not available on PATH.\nInstall Gemini CLI and re-run `vpd install` and `vpd start`.',
      hint: 'Install Gemini CLI, then ensure `gemini` resolves from your PATH.',
    });
  }

  return issues;
}

export async function assessAgentPrerequisites(): Promise<PrereqIssue[]> {
  const snapshot: PrereqSnapshot = {
    preferredAgents: await resolvePreferredAgentsFromConfig(),
    hasClaudeSessions: await hasJsonlFiles(claudeProjectsDir()),
    hasCodexSessions: await hasJsonlFiles(codexSessionsDir()),
    claudeSdkInstalled: await isClaudeSdkInstalled(),
    codexSdkInstalled: await isCodexSdkAvailable(),
    geminiCliInstalled: await commandExists('gemini'),
  };
  return detectPrereqIssues(snapshot);
}

export async function installPrerequisites(issues: PrereqIssue[]): Promise<PrereqInstallResult[]> {
  const results: PrereqInstallResult[] = [];
  for (const issue of issues) {
    if (!issue.autoInstall || !issue.packages || issue.packages.length === 0) {
      continue;
    }
    const result = installPackageCandidates(issue.packages);
    results.push({ id: issue.id, ok: result.ok, error: result.error });
  }
  return results;
}

async function hasJsonlFiles(root: string, limit = 400): Promise<boolean> {
  const queue: string[] = [root];
  let scanned = 0;
  while (queue.length > 0 && scanned < limit) {
    const current = queue.shift();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        return true;
      }
      if (scanned >= limit) break;
    }
  }
  return false;
}

async function resolvePreferredAgentsFromConfig(): Promise<Set<string>> {
  const preferred = new Set<string>([BUILT_IN_DEFAULTS.agent ?? 'claude']);
  const cfg = await loadConfig();

  if (typeof cfg.defaults?.agent === 'string' && cfg.defaults.agent.trim()) {
    preferred.add(cfg.defaults.agent.trim());
  }

  for (const entry of Object.values(cfg.directories ?? {})) {
    const agent = entry?.config?.agent;
    if (typeof agent === 'string' && agent.trim()) {
      preferred.add(agent.trim());
    }
  }
  return preferred;
}

async function isClaudeSdkInstalled(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

function daemonPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function installPackageCandidates(packages: readonly string[]): { ok: boolean; error?: string } {
  const daemonRoot = daemonPackageRoot();
  const npmInvocation = (() => {
    try {
      return resolveNpmInvocationFromNode(process.execPath);
    } catch {
      return { command: 'npm', argsPrefix: [] as string[] };
    }
  })();

  let lastError: string | undefined;
  for (const packageName of packages) {
    const result = spawnSync(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, 'install', `${packageName}@latest`],
      {
        cwd: daemonRoot,
        stdio: 'inherit',
        env: process.env,
      },
    );
    if (!result.error && (result.status ?? 1) === 0) {
      return { ok: true };
    }
    lastError = result.error
      ? result.error instanceof Error
        ? result.error.message
        : String(result.error)
      : `${packageName} install exited with code ${result.status ?? 1}`;
  }
  return { ok: false, error: lastError };
}

async function promptInstall(question: string): Promise<boolean | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await Promise.race([
      rl.question(question),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(TIMED_OUT_TOKEN), PROMPT_TIMEOUT_MS),
      ),
    ]);
    if (answer === TIMED_OUT_TOKEN) return null;
    const normalized = answer.trim().toLowerCase();
    return normalized.length === 0 || normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

export async function maybeOfferAgentPrerequisites(options: {
  silent: boolean;
  asJson: boolean;
}): Promise<void> {
  if (options.silent || options.asJson) return;
  if (process.env['VPD_SKIP_INTERACTIVE_INSTALL_PROMPTS'] === '1') return;
  if (process.env['TSX_WATCH']) return;

  const issues = await assessAgentPrerequisites();
  if (issues.length === 0) return;

  for (const issue of issues) {
    if (!issue.autoInstall) {
      logger.warn(issue.prompt);
      continue;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (issue.hint) logger.warn(`${issue.prompt}\n${issue.hint}`);
      continue;
    }

    const decision = await promptInstall(issue.prompt);
    if (decision === null) {
      logger.log('\nDependency install prompt timed out; continuing startup.');
      continue;
    }
    if (!decision) continue;
    if (!issue.packages || issue.packages.length === 0) continue;

    logger.log(`\nInstalling dependency (${issue.packages.join(' -> ')}) ...`);
    const result = installPackageCandidates(issue.packages);
    if (!result.ok) {
      logger.warn(
        `Dependency install failed (${result.error ?? 'unknown error'}). ${issue.hint ?? 'Please install manually and retry.'}`,
      );
      continue;
    }
    logger.log('Dependency installed. Continuing daemon startup.\n');
  }
}
