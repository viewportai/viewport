import { contextProviderAdapterFor } from '../context-providers/registry.js';
import type { ContextProviderResult } from '../context-providers/types.js';
import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import type { WorkflowContextNode, WorkflowRunRecord } from './types.js';
import { addEvent, renderOptionalTemplate } from './runtime-helpers.js';

interface NormalizedContextRef {
  ref: string;
  as?: string;
  required: boolean;
  description?: string;
  refresh?: 'manual' | 'before_run' | 'on_demand';
}

interface ResolvedContextItem extends ContextProviderResult {
  alias?: string;
}

export async function executeContextNode(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowContextNode,
): Promise<void> {
  const state = run.nodes[nodeId];
  const refs = normalizeRefs(node.refs ?? []);
  const query = await renderOptionalTemplate(node.query, run);
  const providers = selectProviders(run.resourceManifest?.contract.contextProviders ?? [], refs);
  const missingRequired = missingRequiredRefs(refs, providers);
  if (missingRequired.length > 0) {
    throw new Error(
      `Context node ${nodeId} missing required provider(s): ${missingRequired.join(', ')}`,
    );
  }

  const items: ResolvedContextItem[] = [];
  const skipped: Array<{ providerId: string; reason: string }> = [];
  for (const { provider, alias } of providers) {
    const adapter = contextProviderAdapterFor(provider);
    if (!adapter?.search) {
      if (provider.required) {
        throw new Error(`Context provider ${provider.id} does not support search`);
      }
      skipped.push({ providerId: provider.id, reason: 'search_not_supported' });
      continue;
    }
    const result = await adapter.search({
      provider,
      query: query ?? '',
      sizeBudgetBytes: run.resourceManifest?.contract.contextResolution.sizeBudgetBytes,
      actorName: run.machineId,
    });
    items.push(...result.map((item) => ({ ...item, alias })));
  }

  const output = {
    query: query ?? null,
    refs: refs.map((ref) => ({
      ref: ref.ref,
      as: ref.as ?? null,
      required: ref.required,
      refresh: ref.refresh ?? node.refresh ?? 'before_run',
    })),
    refresh: node.refresh ?? 'before_run',
    providerCount: providers.length,
    itemCount: items.length,
    skipped,
    items,
  };

  if (state) {
    state.output = JSON.stringify(output);
    state.outputs = {
      ...(state.outputs ?? {}),
      query: query ?? null,
      itemCount: items.length,
      items,
    };
  }

  addEvent(
    run,
    'node-output',
    `Context node ${nodeId} resolved ${items.length} item${items.length === 1 ? '' : 's'}`,
    {
      query: query ?? null,
      providerCount: providers.length,
      itemCount: items.length,
      skipped,
      items: items.map(metadataOnlyContextItem),
    },
    nodeId,
  );
}

function normalizeRefs(refs: WorkflowContextNode['refs']): NormalizedContextRef[] {
  return (refs ?? []).map((ref): NormalizedContextRef => {
    if (typeof ref === 'string') {
      return { ref, required: false };
    }
    return {
      ref: ref.ref,
      as: ref.as,
      required: ref.required === true,
      description: ref.description,
      refresh: ref.refresh,
    };
  });
}

function selectProviders(
  providers: SessionContextProviderManifest[],
  refs: NormalizedContextRef[],
): Array<{ provider: SessionContextProviderManifest; alias?: string }> {
  if (refs.length === 0) {
    return providers.map((provider) => ({ provider }));
  }

  const selected: Array<{ provider: SessionContextProviderManifest; alias?: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const provider = providers.find((candidate) => matchesProviderRef(candidate, ref.ref));
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    selected.push({ provider, alias: ref.as });
  }
  return selected;
}

function missingRequiredRefs(
  refs: NormalizedContextRef[],
  providers: Array<{ provider: SessionContextProviderManifest }>,
): string[] {
  const selected = new Set(providers.map(({ provider }) => provider.id));
  return refs
    .filter((ref) => ref.required && !selectedProviderMatches(ref.ref, selected, providers))
    .map((ref) => ref.ref);
}

function selectedProviderMatches(
  ref: string,
  selected: Set<string>,
  providers: Array<{ provider: SessionContextProviderManifest }>,
): boolean {
  return providers.some(
    ({ provider }) => selected.has(provider.id) && matchesProviderRef(provider, ref),
  );
}

function matchesProviderRef(provider: SessionContextProviderManifest, ref: string): boolean {
  const normalized = ref.trim();
  return (
    normalized === provider.id ||
    normalized === provider.vault ||
    normalized === `context://${provider.id}` ||
    normalized === `context://${provider.vault}` ||
    normalized === `context://vault/${provider.vault}` ||
    normalized === `provider://${provider.id}`
  );
}

function metadataOnlyContextItem(item: ResolvedContextItem): Record<string, unknown> {
  return {
    id: item.id,
    provider_id: item.provider_id,
    provider: item.provider,
    privacy: item.privacy,
    title: item.title,
    digest: item.digest ?? null,
    source: item.source ?? null,
    score: item.score ?? null,
    alias: item.alias ?? null,
  };
}
