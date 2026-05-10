import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { resolveRepoDocsProvider } from '../context-providers/repo-docs-provider.js';
import { readContextStatus, resolveContextBundle } from '../context/local-edge-store.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'session-context-prompt' });
const MAX_VAULT_PROMPT_ITEMS = 12;

export async function buildSessionPromptWithContext(options: {
  workingDirectory: string;
  prompt: string;
}): Promise<string> {
  const text = options.prompt.trim();
  if (!text) return text;

  const manifest = resolveSessionResourceManifestSync({
    workingDirectory: options.workingDirectory,
  });
  const sections: string[] = [];

  for (const provider of manifest.contract.contextProviders) {
    if (provider.provider !== 'repo-docs') continue;
    const items = await resolveRepoDocsProvider({
      provider,
      query: text,
      sizeBudgetBytes: manifest.contract.contextResolution.sizeBudgetBytes,
    });
    if (items.length === 0) continue;
    sections.push(
      [
        `## ${provider.id} (${provider.provider})`,
        ...items.map((item) => [`### ${item.title}`, item.body].join('\n')),
      ].join('\n\n'),
    );
  }

  const requestedContexts = manifest.resources.contexts;
  for (const context of requestedContexts) {
    try {
      const status = await readContextStatus({ contextResourceId: context.id });
      const record = status.contexts.find(
        (candidate) => candidate.contextResourceId === context.id,
      );
      if (!record) {
        if (context.required) {
          sections.push(
            `## ${context.id}\nRequired Context Vault is configured but not available on this machine.`,
          );
        }
        continue;
      }

      let bundle = await resolveContextBundle({
        contextResourceId: context.id,
        actorName: record.deviceName,
        query: text,
        maxItems: MAX_VAULT_PROMPT_ITEMS,
        includePrivate: false,
      });
      if (bundle.items.length === 0) {
        bundle = await resolveContextBundle({
          contextResourceId: context.id,
          actorName: record.deviceName,
          query: '',
          maxItems: MAX_VAULT_PROMPT_ITEMS,
          includePrivate: false,
        });
      }
      if (bundle.items.length === 0) continue;

      sections.push(
        [
          `## ${context.id}`,
          ...bundle.items.map((item) => [`### ${item.title}`, item.body].join('\n')),
        ].join('\n\n'),
      );
    } catch (error) {
      log.warn(
        { err: error, contextResourceId: context.id },
        'Failed to resolve Context Vault for session prompt',
      );
      if (context.required) {
        sections.push(
          `## ${context.id}\nRequired Context Vault could not be resolved on this machine.`,
        );
      }
    }
  }

  if (sections.length === 0) return text;

  return [
    '<viewport_context>',
    'The following context was resolved locally for this run from the repo contract. Treat it as repo/resource-specific operating context and cite it when relevant.',
    '',
    sections.join('\n\n'),
    '</viewport_context>',
    '',
    '<user_request>',
    text,
    '</user_request>',
  ].join('\n');
}
