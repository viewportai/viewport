import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { readContextStatus, resolveContextBundle } from '../context/local-edge-store.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'session-context-prompt' });

export async function buildSessionPromptWithContext(options: {
  workingDirectory: string;
  prompt: string;
}): Promise<string> {
  const text = options.prompt.trim();
  if (!text) return text;

  const manifest = resolveSessionResourceManifestSync({
    workingDirectory: options.workingDirectory,
  });
  const requestedContexts = manifest.resources.contexts;
  if (requestedContexts.length === 0) return text;

  const sections: string[] = [];
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
        includePrivate: false,
      });
      if (bundle.items.length === 0) {
        bundle = await resolveContextBundle({
          contextResourceId: context.id,
          actorName: record.deviceName,
          query: '',
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
    'The following approved Context Vault entries were resolved locally for this run. Treat them as repo/resource-specific operating context and cite them when relevant.',
    '',
    sections.join('\n\n'),
    '</viewport_context>',
    '',
    '<user_request>',
    text,
    '</user_request>',
  ].join('\n');
}
