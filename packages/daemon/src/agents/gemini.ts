/**
 * Gemini agent definition — explicit CLI integration (non-PTY).
 */

import type { AgentDefinition } from '../core/agent-registry.js';
import { commandExists } from './command-detection.js';

export const geminiAgent: AgentDefinition = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  tier: 'sdk',

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
    resume: true,
    extendedThinking: false,
  },

  detection: {
    check: async () => commandExists('gemini'),
    description: 'Gemini CLI (gemini)',
  },

  createAdapter: async () => {
    const { GeminiCliAdapter } = await import('../adapters/gemini-cli.js');
    return new GeminiCliAdapter();
  },

  createDiscovery: async () => {
    const { GeminiDiscovery } = await import('../discovery/gemini.js');
    return new GeminiDiscovery();
  },

  watchDirs: () => [],
};
