import { resolveContextBundle, type ContextBundle } from '../context/local-edge-store.js';
import { proposeContextEntry } from '../context/local-edge-candidates.js';
import { refreshContextFromSavedTarget } from '../context/local-edge-auto-sync.js';
import type { ContextProviderAdapter, ContextProviderResult } from './types.js';

const DEFAULT_VAULT_MAX_ITEMS = 25;
const MAX_VAULT_ITEMS_PER_PROVIDER = 50;
const ASSUMED_VAULT_ITEM_BYTES = 2048;

export const viewportVaultProviderAdapter: ContextProviderAdapter = {
  kind: 'viewport-vault',
  async search(input) {
    if (!input.provider.vault) throw new Error('viewport-vault provider missing vault id');
    await refreshContextFromSavedTarget({
      contextResourceId: input.provider.vault,
      actorName: input.actorName,
      home: input.home,
    });
    const bundle = await resolveContextBundle({
      contextResourceId: input.provider.vault,
      actorName: input.actorName,
      query: input.query,
      maxItems: maxItemsForBudget(input.sizeBudgetBytes),
      credentials: input.credentials,
      home: input.home,
    });
    return bundleResults(input.provider, bundle);
  },
  async get(input) {
    if (!input.provider.vault) throw new Error('viewport-vault provider missing vault id');
    await refreshContextFromSavedTarget({
      contextResourceId: input.provider.vault,
      actorName: input.actorName,
      home: input.home,
    });
    const bundle = await resolveContextBundle({
      contextResourceId: input.provider.vault,
      actorName: input.actorName,
      query: '',
      maxItems: maxItemsForBudget(input.sizeBudgetBytes),
      credentials: input.credentials,
      home: input.home,
    });
    return bundleResults(input.provider, bundle).find((item) => item.id === input.entryId);
  },
  async propose(input) {
    if (!input.provider.vault) throw new Error('viewport-vault provider missing vault id');
    const source =
      input.source ??
      (input.sourceProvider
        ? `contract://${input.manifestDigest}/${input.sourceProvider.id}/fallback/${input.provider.id}`
        : `contract://${input.manifestDigest}/${input.provider.id}`);
    const candidate = await proposeContextEntry({
      contextResourceId: input.provider.vault,
      actorName: input.actorName,
      title: input.title,
      body: input.body,
      source,
      sourceKind: input.sourceKind,
      credentials: input.credentials,
      home: input.home,
    });
    return {
      candidate_id: candidate.id,
      payload_digest: candidate.bodyDigest,
    };
  },
};

function maxItemsForBudget(sizeBudgetBytes?: number): number {
  if (!sizeBudgetBytes || sizeBudgetBytes <= 0) return DEFAULT_VAULT_MAX_ITEMS;
  return Math.max(
    1,
    Math.min(MAX_VAULT_ITEMS_PER_PROVIDER, Math.floor(sizeBudgetBytes / ASSUMED_VAULT_ITEM_BYTES)),
  );
}

function bundleResults(
  provider: { id: string; provider: string; privacy: string; vault?: string },
  bundle: ContextBundle,
): ContextProviderResult[] {
  return bundle.items.map((item) => ({
    id: item.id,
    provider_id: provider.id,
    provider: provider.provider,
    privacy: provider.privacy,
    title: item.title,
    body: item.body,
    source: `viewport-vault://${provider.vault}/${item.id}`,
  }));
}
