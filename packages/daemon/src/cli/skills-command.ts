import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';

type SkillAgent = 'claude-code' | 'cursor';

interface SkillDefinition {
  agent: SkillAgent;
  defaultPath: string;
  content: string;
}

interface InstalledSkill {
  agent: SkillAgent;
  path: string;
  changed: boolean;
}

interface SkippedSkill {
  agent: SkillAgent;
  path: string;
  reason: string;
}

const CLAUDE_CODE_SKILL = `# Viewport Agent Contract

Use the local \`vpd\` CLI to resolve team contracts, fetch context, propose new
context candidates, and run Viewport workflows. Treat \`vpd\` as the source of
truth for what this repo/session is allowed to use.

## Before Starting Work

1. Run \`vpd validate --path . --json\`.
2. If validation is not ready, explain the issue and ask the user before continuing.
3. Run \`vpd contract resolve --path . --json\` when you need the resolved providers,
   workflows, and manifest digest for this repo.

## Context

- Search local/trusted-edge context with:
  \`vpd context search --query "<topic>" --json\`
- Fetch one result with:
  \`vpd context get <entry-id> --json\`
- Propose reusable context only when the user asks or when a durable team rule was
  clearly learned:
  \`vpd context propose --title "<title>" --body "<body>" --json\`

  If the resolved repo contract has exactly one proposal-capable provider, vpd uses
  it automatically. If more than one provider can accept proposals, pass
  \`--provider <provider-id>\`.

Context proposals are candidates. They do not become shared context until a human
approves them in Viewport Inbox.

- Add approved context directly only when the user explicitly tells you to save a
  specific note as accepted context:
  \`vpd context add --provider <provider-id> --path . --title "<title>" --body "<body>" --json\`

Use \`context propose\` for agent-learned suggestions. Use \`context add\` only for
human-authored or explicitly human-approved context.

## Workflows

- Run declared workflows with:
  \`vpd workflow run <workflow-id> --path . --json\`
- Use workflow files directly only when the user explicitly asks to run an
  undeclared local workflow.
- If a workflow blocks for approval, tell the user where the decision is waiting.

## Safety Rules

- Never paste secrets into context.
- Before editing, deleting, or running risky paths, call:
  \`vpd guard check --path "<path>" --action edit --json\`
  If the decision is \`requires_approval\`, stop and ask the user to route the
  approval through Viewport before continuing.
- Never treat third-party context providers as control-plane-blind unless the
  \`vpd contract resolve --json\` privacy field says so.
- Prefer the repo contract over guessed conventions.
`;

const CURSOR_SKILL = CLAUDE_CODE_SKILL;

const SKILLS: SkillDefinition[] = [
  {
    agent: 'claude-code',
    defaultPath: path.join(os.homedir(), '.claude', 'skills', 'viewport.md'),
    content: CLAUDE_CODE_SKILL,
  },
  {
    agent: 'cursor',
    defaultPath: path.join(os.homedir(), '.cursor', 'rules', 'viewport.mdc'),
    content: CURSOR_SKILL,
  },
];

export async function skills(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showSkillsHelp();
    return;
  }
  if (subcommand === 'install') {
    await installSkills();
    return;
  }
  throw new Error(skillsUsage());
}

function skillsUsage(): string {
  return 'Usage: vpd skills install [claude-code|cursor|all] [--target <path>] [--force] [--json]';
}

function showSkillsHelp(): void {
  console.log(skillsUsage());
}

async function installSkills(): Promise<void> {
  const requested = parseRequestedAgent(getArgs()[2]);
  const target = getFlag('target');
  if (target && requested.length !== 1) {
    throw new Error('--target can only be used when installing one agent skill');
  }

  const installed: InstalledSkill[] = [];
  const skipped: SkippedSkill[] = [];
  for (const skill of requested) {
    const definition = SKILLS.find((candidate) => candidate.agent === skill);
    if (!definition) {
      throw new Error(`Unsupported skill agent: ${skill}`);
    }
    const destination = path.resolve(target ?? definition.defaultPath);
    const existing = await readIfExists(destination);
    if (existing !== undefined && existing === definition.content) {
      installed.push({ agent: definition.agent, path: destination, changed: false });
      continue;
    }
    if (existing !== undefined && !hasFlag('force')) {
      skipped.push({
        agent: definition.agent,
        path: destination,
        reason: 'exists_use_force_to_overwrite',
      });
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, definition.content, 'utf8');
    installed.push({ agent: definition.agent, path: destination, changed: true });
  }

  const ok = skipped.length === 0;
  const output = {
    schema_version: 'viewport.cli.skills_install/v1',
    command: 'skills install',
    ok,
    installed,
    skipped,
    errors: skipped.map((item) => ({
      code: item.reason,
      agent: item.agent,
      path: item.path,
    })),
  };
  if (isJsonMode()) {
    printJson(output);
    return;
  }
  for (const item of installed) {
    console.log(`${item.changed ? 'Installed' : 'Already installed'} ${item.agent}: ${item.path}`);
  }
  for (const item of skipped) {
    console.log(`Skipped ${item.agent}: ${item.path} (${item.reason})`);
  }
  if (!ok) {
    throw new Error('Some skills were skipped. Re-run with --force to overwrite existing files.');
  }
}

function parseRequestedAgent(raw: string | undefined): SkillAgent[] {
  if (!raw || raw.startsWith('--') || raw === 'all') {
    return SKILLS.map((skill) => skill.agent);
  }
  if (raw === 'claude-code' || raw === 'cursor') return [raw];
  throw new Error(skillsUsage());
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
