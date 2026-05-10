import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import { proposeContextEntry } from '../context/local-edge-candidates.js';

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

export function proposeToViewportVaultProvider(
  provider: SessionContextProviderManifest,
  input: ContextProviderProposeInput,
) {
  if (provider.provider !== 'viewport-vault' || !provider.vault) {
    throw new Error(`Provider ${provider.id} does not have a v1 propose adapter.`);
  }
  const source =
    input.source ??
    (input.sourceProvider
      ? `contract://${input.manifestDigest}/${input.sourceProvider.id}/fallback/${provider.id}`
      : `contract://${input.manifestDigest}/${provider.id}`);
  return proposeContextEntry({
    contextResourceId: provider.vault,
    actorName: input.actorName,
    title: input.title,
    body: input.body,
    source,
    sourceKind: input.sourceKind,
    credentials: input.credentials,
    home: input.home,
  });
}
