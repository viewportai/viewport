/**
 * Codex agent definition — SDK-backed Codex integration.
 */

import { codexSessionsDir } from '../discovery/codex.js';
import type { AgentDefinition } from '../core/agent-registry.js';
import { importCodexSdkModule, isCodexSdkAvailable } from '../adapters/codex-sdk-loader.js';

export const codexAgent: AgentDefinition = {
  id: 'codex',
  displayName: 'Codex',
  tier: 'sdk',

  defaults: {
    commitOn: [],
    autoApprove: [],
    requireApproval: [],
    deny: [],
  },

  capabilities: {
    structuredToolCalls: true,
    permissionCallbacks: false,
    tokenUsage: true,
    resume: true,
    extendedThinking: false,
  },

  detection: {
    check: async () => isCodexSdkAvailable(),
    description: 'Codex SDK (@openai/codex-sdk or @openai/codex)',
  },

  createAdapter: async () => {
    try {
      const { CodexAdapter } = await import('../adapters/codex.js');
      return new CodexAdapter();
    } catch {
      return null;
    }
  },

  createDiscovery: async () => {
    const { CodexDiscovery } = await import('../discovery/codex.js');
    return new CodexDiscovery();
  },

  watchDirs: () => [codexSessionsDir()],

  fetchModels: async () => {
    // SDK model listing may change; keep this resilient.
    try {
      const loaded = await importCodexSdkModule();
      if (!loaded?.module.Codex) return [];
      const client = new loaded.module.Codex({
        apiKey: process.env['OPENAI_API_KEY'] || process.env['CODEX_API_KEY'],
      });
      if (typeof client.supportedModels !== 'function') return [];
      const models = await client.supportedModels();
      return models.map((m) => ({
        value: m.value,
        displayName: m.displayName ?? m.value,
        description: m.description ?? 'Codex model',
      }));
    } catch {
      return [];
    }
  },
};
