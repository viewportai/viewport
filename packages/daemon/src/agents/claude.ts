/**
 * Claude agent definition — registers Claude Code as a Viewport agent.
 *
 * All Claude-specific knowledge lives here:
 * - Tool names (Edit, Write, Bash, etc.)
 * - Permission defaults
 * - SDK detection and adapter creation
 * - Session discovery from ~/.claude/projects/
 */

import path from 'node:path';
import os from 'node:os';
import type { AgentDefinition } from '../core/agent-registry.js';
import type { AgentAdapter } from '../core/interfaces.js';

/** Claude Code's tool names for git commit triggers. */
const CLAUDE_COMMIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'MultiEdit'];

/** Claude Code tools that are safe to auto-approve (read-only). */
const CLAUDE_AUTO_APPROVE = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** Claude Code tools that require explicit user approval. */
const CLAUDE_REQUIRE_APPROVAL = ['Edit', 'Write', 'Bash', 'NotebookEdit', 'MultiEdit'];

export const claudeAgent: AgentDefinition = {
  id: 'claude',
  displayName: 'Claude Code',
  tier: 'sdk',

  defaults: {
    commitOn: CLAUDE_COMMIT_TOOLS,
    autoApprove: CLAUDE_AUTO_APPROVE,
    requireApproval: CLAUDE_REQUIRE_APPROVAL,
    deny: [],
  },

  capabilities: {
    structuredToolCalls: true,
    permissionCallbacks: true,
    tokenUsage: true,
    resume: true,
    extendedThinking: true,
  },

  detection: {
    check: async () => {
      try {
        await import('@anthropic-ai/claude-agent-sdk');
        return true;
      } catch {
        return false;
      }
    },
    description: 'Claude Code SDK (@anthropic-ai/claude-agent-sdk)',
  },

  createAdapter: async (): Promise<AgentAdapter | null> => {
    try {
      // Dynamic import to avoid hard failure
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import
      const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as any;
      const queryFn = sdk.query ?? sdk.default?.query;
      if (!queryFn) return null;

      const { ClaudeAdapter } = await import('../adapters/claude.js');
      return new ClaudeAdapter(queryFn);
    } catch {
      return null;
    }
  },

  createDiscovery: async () => {
    const { ClaudeDiscovery } = await import('../discovery/claude.js');
    return new ClaudeDiscovery();
  },

  watchDirs: () => {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    return [claudeProjectsDir];
  },

  fetchModels: async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import
      const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as any;
      const queryFn = sdk.query ?? sdk.default?.query;
      if (!queryFn) return [];

      // Create a minimal query to access supportedModels().
      // The query initializes the SDK process which can list models.
      const q = queryFn({ prompt: '', options: { maxTurns: 0 } });
      try {
        const models = await q.supportedModels();
        return models;
      } finally {
        q.close();
      }
    } catch {
      return [];
    }
  },
};
