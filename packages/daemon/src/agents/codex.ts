/**
 * Codex agent definition — SDK-backed Codex integration.
 */

import { codexSessionsDir } from '../discovery/codex.js';
import type { AgentDefinition } from '../core/agent-registry.js';
import { importCodexSdkModule, isCodexSdkAvailable } from '../adapters/codex-sdk-loader.js';
import { resolveCodexPathOverride } from '../adapters/codex.js';
import { commandExists } from './command-detection.js';
import { DEFAULT_CODEX_MODEL } from './codex-defaults.js';

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
    check: async () => {
      if (! (await isCodexSdkAvailable())) return false;
      return commandExists(resolveCodexPathOverride());
    },
    description: 'Codex SDK plus executable codex CLI bridge',
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
      if (!loaded?.module.Codex) return fallbackCodexModels();
      const client = new loaded.module.Codex({
        apiKey: process.env['OPENAI_API_KEY'] || process.env['CODEX_API_KEY'],
      });
      if (typeof client.supportedModels !== 'function') return fallbackCodexModels();
      const models = await client.supportedModels();
      return models.map((m) => ({
        agentId: 'codex',
        value: m.value,
        displayName: m.displayName ?? m.value,
        description: m.description ?? 'Codex model',
      }));
    } catch {
      return fallbackCodexModels();
    }
  },
};

function fallbackCodexModels() {
  return [
    {
      agentId: 'codex',
      value: DEFAULT_CODEX_MODEL,
      displayName: `${DEFAULT_CODEX_MODEL} (Viewport default)`,
      description:
        'Default Codex model used by Viewport when the Codex SDK cannot report supported models.',
    },
  ];
}
