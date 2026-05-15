import type { AgentDefinition } from '../core/agent-registry.js';
import { PtyAdapter } from '../adapters/pty.js';

const DEFAULT_CUSTOM_AGENT_ID = 'custom-command';
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;

export function customCommandAgentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentDefinition | null {
  const command = env['VIEWPORT_CUSTOM_AGENT_COMMAND']?.trim();
  if (!command) return null;

  const id = env['VIEWPORT_CUSTOM_AGENT_ID']?.trim() || DEFAULT_CUSTOM_AGENT_ID;
  if (!SAFE_AGENT_ID.test(id)) {
    throw new Error(
      `Invalid VIEWPORT_CUSTOM_AGENT_ID '${id}'. Use letters, numbers, '.', '_' or '-'.`,
    );
  }

  const displayName = env['VIEWPORT_CUSTOM_AGENT_NAME']?.trim() || 'Custom command agent';
  const defaultArgs = parseCustomAgentArgs(env);
  const promptMode = parsePromptMode(env['VIEWPORT_CUSTOM_AGENT_PROMPT_MODE']);

  return {
    id,
    displayName,
    tier: 'pty',
    defaults: {
      commitOn: [],
      autoApprove: [],
      requireApproval: [],
      deny: [],
    },
    capabilities: {
      structuredToolCalls: false,
      permissionCallbacks: false,
      tokenUsage: false,
      resume: false,
      extendedThinking: false,
    },
    detection: {
      check: async () => true,
      description: `Custom command agent (${command})`,
    },
    createAdapter: async () =>
      new PtyAdapter(id, command, {
        defaultArgs,
        promptMode,
      }),
  };
}

function parseCustomAgentArgs(env: NodeJS.ProcessEnv): string[] {
  const json = env['VIEWPORT_CUSTOM_AGENT_ARGS_JSON'];
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error('VIEWPORT_CUSTOM_AGENT_ARGS_JSON must be a JSON array of strings.');
    }
    return parsed;
  }

  const raw = env['VIEWPORT_CUSTOM_AGENT_ARGS']?.trim();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function parsePromptMode(value: string | undefined): 'positional' | 'stdin' | string {
  const mode = value?.trim();
  return mode || 'stdin';
}
