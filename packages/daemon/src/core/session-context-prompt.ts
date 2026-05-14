import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { resolveRepoDocsProvider } from '../context-providers/repo-docs-provider.js';
import { readContextStatus, resolveContextBundle } from '../context/local-edge-store.js';
import { listLocalPendingContextCandidates } from '../context/local-edge-candidates.js';
import { refreshContextFromSavedTarget } from '../context/local-edge-auto-sync.js';
import { resolveLocalOrgBindingSync } from '../cli/org-binding.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'session-context-prompt' });
const MAX_VAULT_PROMPT_ITEMS = 12;
const MAX_PENDING_LOCAL_ITEMS = 3;

export interface ResolvedSessionContextSections {
  hasContextContract: boolean;
  manifestDigest: string;
  sections: string[];
}

export async function buildSessionPromptWithContext(options: {
  workingDirectory: string;
  prompt: string;
}): Promise<string> {
  const text = options.prompt.trim();
  if (!text) return text;

  const resolved = await resolveSessionContextSections({
    workingDirectory: options.workingDirectory,
    query: text,
    includePendingLocal: false,
    maxVaultItems: MAX_VAULT_PROMPT_ITEMS,
  });

  if (resolved.sections.length === 0) return text;

  return [
    '<viewport_context>',
    'The following context was resolved locally for this run from the repo contract. Treat it as repo/resource-specific operating context and cite it when relevant.',
    '',
    resolved.sections.join('\n\n'),
    '</viewport_context>',
    '',
    '<user_request>',
    text,
    '</user_request>',
  ].join('\n');
}

export async function buildSessionContextBlock(options: {
  workingDirectory: string;
  query: string;
  includePendingLocal?: boolean;
  maxVaultItems?: number;
}): Promise<string | null> {
  const resolved = await resolveSessionContextSections({
    workingDirectory: options.workingDirectory,
    query: options.query,
    includePendingLocal: options.includePendingLocal ?? true,
    maxVaultItems: options.maxVaultItems ?? 6,
  });
  if (resolved.sections.length === 0) return null;
  return [
    '<viewport_context>',
    'Viewport resolved this context locally from the repo contract. Approved entries are shared context. Pending local entries are only proposals from this device and are not approved team context.',
    '',
    resolved.sections.join('\n\n'),
    '</viewport_context>',
  ].join('\n');
}

export async function resolveSessionContextSections(options: {
  workingDirectory: string;
  query: string;
  includePendingLocal?: boolean;
  maxVaultItems?: number;
}): Promise<ResolvedSessionContextSections> {
  const text = options.query.trim();
  const manifest = resolveSessionResourceManifestSync({
    workingDirectory: options.workingDirectory,
  });
  const workspaceId = resolveLocalOrgBindingSync(options.workingDirectory)?.organizationId;
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
    const provider = manifest.contract.contextProviders.find(
      (candidate) => candidate.provider === 'viewport-vault' && candidate.vault === context.id,
    );
    const guidance = contextGuidanceLines(provider?.useWhen, provider?.updateWhen);
    try {
      const status = await readContextStatus({ contextResourceId: context.id });
      const record = status.contexts.find(
        (candidate) => candidate.contextResourceId === context.id,
      );
      if (!record) {
        if (guidance.length > 0 || context.required) {
          sections.push(
            [
              `## ${context.id}`,
              ...guidance,
              context.required
                ? 'Required Context Vault is configured but not available on this machine.'
                : 'Context Vault is configured but not available on this machine.',
            ].join('\n'),
          );
        }
        continue;
      }

      await refreshContextFromSavedTarget({
        contextResourceId: context.id,
        workspaceId,
        actorName: record.deviceName,
      });

      let bundle = await resolveContextBundle({
        contextResourceId: context.id,
        actorName: record.deviceName,
        query: text,
        maxItems: options.maxVaultItems ?? MAX_VAULT_PROMPT_ITEMS,
        includePrivate: false,
      });
      if (bundle.items.length === 0) {
        bundle = await resolveContextBundle({
          contextResourceId: context.id,
          actorName: record.deviceName,
          query: '',
          maxItems: options.maxVaultItems ?? MAX_VAULT_PROMPT_ITEMS,
          includePrivate: false,
        });
      }
      const contextSections = bundle.items.map((item) =>
        [`### ${item.title}`, `Trust: ${item.trustState}`, item.body].join('\n'),
      );

      if (options.includePendingLocal) {
        const pending = await listLocalPendingContextCandidates({
          contextResourceId: context.id,
          actorName: record.deviceName,
          query: text,
          maxItems: MAX_PENDING_LOCAL_ITEMS,
        });
        contextSections.push(
          ...pending.map((item) =>
            [
              `### ${item.title}`,
              `Trust: pending_local (${item.status})`,
              'This is a local proposal from this device. Use it as a working note for this author, not as approved team context.',
              item.body,
            ].join('\n'),
          ),
        );
      }

      if (contextSections.length === 0 && guidance.length === 0) continue;
      sections.push([`## ${context.id}`, ...guidance, ...contextSections].join('\n\n'));
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

  return {
    hasContextContract:
      manifest.contract.contextProviders.length > 0 || manifest.resources.contexts.length > 0,
    manifestDigest: manifest.manifestDigest,
    sections,
  };
}

function contextGuidanceLines(
  useWhen: string | undefined,
  updateWhen: string | undefined,
): string[] {
  const lines: string[] = [];
  const use = useWhen?.trim();
  const update = updateWhen?.trim();
  if (use) lines.push(`Use this context when: ${use}`);
  if (update) lines.push(`Propose an update when: ${update}`);
  return lines;
}
