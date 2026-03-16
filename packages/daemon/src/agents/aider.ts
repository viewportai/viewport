/**
 * Aider agent definition — registers Aider as a Viewport PTY agent.
 *
 * Aider manages its own git commits, so we disable Viewport's git tracking
 * for Aider sessions to avoid conflicts.
 */

import type { AgentDefinition } from '../core/agent-registry.js';
import { PtyAdapter } from '../adapters/pty.js';
import { commandExists } from './command-detection.js';

export const aiderAgent: AgentDefinition = {
  id: 'aider',
  displayName: 'Aider',
  tier: 'pty',

  defaults: {
    commitOn: [], // Aider manages its own git commits
    autoApprove: [], // No structured tools in PTY mode
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
    check: async () => commandExists('aider'),
    description: 'Aider CLI (aider)',
  },

  createAdapter: async () => {
    return new PtyAdapter('aider', 'aider', {
      defaultArgs: ['--yes-always'],
      promptMode: 'positional',
    });
  },
};
