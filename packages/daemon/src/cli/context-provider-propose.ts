import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import { contextProviderAdapterFor } from '../context-providers/registry.js';

export type ContextCandidateSourceKind = 'workflow' | 'plan' | 'integration';

export interface ContextProviderProposeInput {
  manifestDigest: string;
  actorName: string;
  title: string;
  body: string;
  sourceKind: ContextCandidateSourceKind;
  credentials: { passphrase: string; recoveryCode: string };
  home?: string;
  sourceProvider?: SessionContextProviderManifest;
  source?: string;
}

export function fallbackProposeProvider(
  providers: SessionContextProviderManifest[],
  explicitProviderId: string | undefined,
  requestedProviderId: string,
): SessionContextProviderManifest | undefined {
  const candidates = explicitProviderId
    ? providers.filter((provider) => provider.id === explicitProviderId)
    : providers;
  return candidates.find(
    (provider) =>
      provider.id !== requestedProviderId &&
      provider.provider === 'viewport-vault' &&
      Boolean(provider.vault) &&
      provider.capabilities.includes('propose'),
  );
}

export function proposeToContextProvider(
  provider: SessionContextProviderManifest,
  input: ContextProviderProposeInput,
): Promise<{
  id: string;
  bodyDigest: string;
  status?: string;
  pullRequestUrl?: string;
  branch?: string;
  source?: string;
}> {
  const adapter = contextProviderAdapterFor(provider);
  if (!adapter?.propose) {
    throw new Error(`Provider ${provider.id} does not have a v1 propose adapter.`);
  }
  return adapter
    .propose({
      provider,
      ...input,
    })
    .then((result) => ({
      id: result.candidate_id,
      bodyDigest: result.payload_digest,
      status: result.status,
      pullRequestUrl: result.pull_request_url,
      branch: result.branch,
      source: result.source,
    }));
}

export const proposeToViewportVaultProvider = proposeToContextProvider;
