import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import { confluenceProviderAdapter } from './confluence-provider.js';
import { githubRepoProviderAdapter } from './github-repo-provider.js';
import { notionProviderAdapter } from './notion-provider.js';
import { repoDocsProviderAdapter } from './repo-docs-provider.js';
import type { ContextProviderAdapter } from './types.js';
import { viewportVaultProviderAdapter } from './viewport-vault-provider.js';

const ADAPTERS = new Map<SessionContextProviderManifest['provider'], ContextProviderAdapter>(
  [
    repoDocsProviderAdapter,
    viewportVaultProviderAdapter,
    githubRepoProviderAdapter,
    notionProviderAdapter,
    confluenceProviderAdapter,
  ].map((adapter) => [adapter.kind, adapter]),
);

export function contextProviderAdapterFor(
  provider: SessionContextProviderManifest,
): ContextProviderAdapter | undefined {
  return ADAPTERS.get(provider.provider);
}

export function supportedContextProviderKinds(): string[] {
  return [...ADAPTERS.keys()].sort();
}
