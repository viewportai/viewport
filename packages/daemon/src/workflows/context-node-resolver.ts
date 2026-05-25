import { createHash } from 'node:crypto';
import { contextProviderAdapterFor } from '../context-providers/registry.js';
import type { ContextProviderResult } from '../context-providers/types.js';
import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import type {
  WorkflowContext,
  WorkflowContextNode,
  WorkflowContextReceiptRecord,
  WorkflowNodeContextEnvelope,
  WorkflowRunRecord,
} from './types.js';
import { addEvent, renderOptionalTemplate } from './runtime-helpers.js';

interface NormalizedContextRef {
  ref: string;
  as?: string;
  required: boolean;
  description?: string;
  refresh?: 'manual' | 'before_run' | 'on_demand';
  maxItems?: number;
}

interface ResolvedContextItem extends ContextProviderResult {
  alias?: string;
}

export interface NodeContextSelection {
  promptBlock: string | null;
  briefing: {
    schema: 'viewport.context_briefing/v1';
    nodeId: string;
    selectedSources: Array<Record<string, unknown>>;
    topEntries: Array<Record<string, unknown>>;
    freshness: Array<Record<string, unknown>>;
    confidence: Array<Record<string, unknown>>;
    securityClassification: Array<Record<string, unknown>>;
    whySelected: Array<Record<string, unknown>>;
    retrievalCaps: Record<string, unknown>;
    excludedSensitiveSources: string[];
    writeTargets: unknown[];
  };
  basis: {
    schema: 'viewport.node_context_basis/v1';
    nodeId: string;
    mode: 'workflow_default' | 'node_envelope' | 'none';
    query: string | null;
    maxItems: number | null;
    writeTargets: unknown[];
    refs: Array<{
      ref: string;
      as: string | null;
      required: boolean;
      refresh: string;
      maxItems: number | null;
    }>;
    excludedRefs: string[];
    selectedItems: Array<Record<string, unknown>>;
    skipped: Array<{ providerId: string; reason: string }>;
  };
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
    const refMaxItems = refMaxItemsForProvider(provider, refs);
    const capped = refMaxItems === null ? result : result.slice(0, refMaxItems);
    items.push(...capped.map((item) => ({ ...item, alias })));
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
  const contextReceipts = buildContextReceipts({
    run,
    nodeId,
    query,
    refs,
    providers,
    items,
  });
  run.contextReceipts = [
    ...(run.contextReceipts ?? []).filter((receipt) => receipt.usedBy.nodeId !== nodeId),
    ...contextReceipts,
  ];

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

export async function resolvePromptNodeContext(input: {
  run: WorkflowRunRecord;
  nodeId: string;
  workflowContext?: WorkflowContext;
  nodeContext?: WorkflowNodeContextEnvelope;
  prompt: string;
}): Promise<NodeContextSelection> {
  const effective = effectivePromptContext(input.workflowContext ?? [], input.nodeContext);
  if (effective.refs.length === 0) {
    return emptyNodeContextBasis(input.nodeId);
  }

  const query = await renderOptionalTemplate(effective.query ?? input.prompt, input.run);
  const providers = selectProviders(
    input.run.resourceManifest?.contract.contextProviders ?? [],
    effective.refs,
  );
  const missingRequired = missingRequiredRefs(effective.refs, providers);
  if (missingRequired.length > 0) {
    throw new Error(
      `Prompt node ${input.nodeId} missing required context provider(s): ${missingRequired.join(', ')}`,
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
      sizeBudgetBytes: input.run.resourceManifest?.contract.contextResolution.sizeBudgetBytes,
      actorName: input.run.machineId,
      credentials: contextProviderCredentials(provider),
    });
    const refMaxItems = refMaxItemsForProvider(provider, effective.refs);
    const capped = refMaxItems === null ? result : result.slice(0, refMaxItems);
    items.push(...capped.map((item) => ({ ...item, alias })));
  }

  const selectedItems = items.slice(0, effective.maxItems ?? items.length);
  const contextReceipts = buildContextReceipts({
    run: input.run,
    nodeId: input.nodeId,
    query,
    refs: effective.refs,
    providers,
    items: selectedItems,
  });
  input.run.contextReceipts = [
    ...(input.run.contextReceipts ?? []).filter((receipt) => receipt.usedBy.nodeId !== input.nodeId),
    ...contextReceipts,
  ];

  const basis: NodeContextSelection['basis'] = {
    schema: 'viewport.node_context_basis/v1',
    nodeId: input.nodeId,
    mode: effective.mode,
    query: query ?? null,
    maxItems: effective.maxItems,
    writeTargets: effective.writeTargets,
    refs: effective.refs.map((ref) => ({
      ref: ref.ref,
      as: ref.as ?? null,
      required: ref.required,
      refresh: ref.refresh ?? 'before_run',
      maxItems: ref.maxItems ?? null,
    })),
    excludedRefs: effective.excludedRefs,
    selectedItems: selectedItems.map(metadataOnlyContextItem),
    skipped,
  };
  const briefing = buildContextBriefing({
    nodeId: input.nodeId,
    basis,
    items: selectedItems,
  });

  addEvent(
    input.run,
    'node-context-selected',
    `Node ${input.nodeId} selected ${selectedItems.length} context item${selectedItems.length === 1 ? '' : 's'}`,
    basis,
    input.nodeId,
  );

  return {
    promptBlock: selectedItems.length > 0 ? formatPromptContextBlock(basis, selectedItems) : null,
    basis,
    briefing,
  };
}

function buildContextReceipts(input: {
  run: WorkflowRunRecord;
  nodeId: string;
  query?: string;
  refs: NormalizedContextRef[];
  providers: Array<{ provider: SessionContextProviderManifest; alias?: string }>;
  items: ResolvedContextItem[];
}): WorkflowContextReceiptRecord[] {
  const resolvedAt = new Date().toISOString();
  return input.items.map((item) => {
    const provider = input.providers.find(
      (candidate) => candidate.provider.id === item.provider_id,
    )?.provider;
    return {
      schema: 'viewport.context_receipt/v1',
      package: contextPackageName(item),
      requested: requestedContextRef({
        item,
        refs: input.refs,
        provider,
      }),
      resolvedVersion: resolvedContextVersion(provider, item),
      provider: item.provider,
      digest: contextDigest(item),
      freshness: 'resolved_at_run',
      usedBy: {
        runId: input.run.id,
        nodeId: input.nodeId,
        providerId: item.provider_id,
        alias: item.alias ?? null,
      },
      resolvedAt,
    };
  });
}

function contextPackageName(item: ResolvedContextItem): string {
  return item.provider_id.trim() || item.provider;
}

function requestedContextRef(input: {
  item: ResolvedContextItem;
  refs: NormalizedContextRef[];
  provider?: SessionContextProviderManifest;
}): string {
  const matchedRef = input.refs.find(
    (ref) => input.provider && matchesProviderRef(input.provider, ref.ref),
  );
  return matchedRef?.ref ?? providerReceiptRef(input.provider) ?? input.item.provider_id;
}

function resolvedContextVersion(
  provider: SessionContextProviderManifest | undefined,
  item: ResolvedContextItem,
): string {
  const version = [provider?.ref, provider?.branch, provider?.vault, item.digest].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
  );
  return version ?? 'unversioned';
}

function providerReceiptRef(
  provider: SessionContextProviderManifest | undefined,
): string | undefined {
  if (!provider) return undefined;
  return provider.id || provider.vault || provider.ref || provider.repo || provider.provider;
}

function contextDigest(item: ResolvedContextItem): string {
  if (item.digest?.startsWith('sha256:')) {
    return item.digest;
  }

  return `sha256:${createHash('sha256').update(item.body).digest('hex')}`;
}

function emptyNodeContextBasis(nodeId: string): NodeContextSelection {
  const basis: NodeContextSelection['basis'] = {
    schema: 'viewport.node_context_basis/v1',
    nodeId,
    mode: 'none',
    query: null,
    maxItems: null,
    writeTargets: [],
    refs: [],
    excludedRefs: [],
    selectedItems: [],
    skipped: [],
  };

  return {
    promptBlock: null,
    basis,
    briefing: buildContextBriefing({ nodeId, basis, items: [] }),
  };
}

function buildContextBriefing(input: {
  nodeId: string;
  basis: NodeContextSelection['basis'];
  items: ResolvedContextItem[];
}): NodeContextSelection['briefing'] {
  const topEntries = input.items.map((item, index) => ({
    rank: index + 1,
    id: item.id,
    label: item.alias ?? item.provider_id,
    provider: item.provider,
    provider_id: item.provider_id,
    title: item.title,
    digest: contextDigest(item),
    score: item.score ?? null,
    source: safeContextSource(item),
  }));
  const selectedSources = input.basis.refs.map((ref) => ({
    ref: ref.ref,
    as: ref.as,
    required: ref.required,
    maxItems: ref.maxItems,
  }));

  return {
    schema: 'viewport.context_briefing/v1',
    nodeId: input.nodeId,
    selectedSources,
    topEntries,
    freshness: input.basis.selectedItems.map((item) => ({
      digest: item.digest,
      freshness: 'resolved_at_run',
    })),
    confidence: input.basis.selectedItems.map((item) => ({
      digest: item.digest,
      score: item.score ?? null,
    })),
    securityClassification: input.basis.selectedItems.map((item) => ({
      digest: item.digest,
      privacy: item.privacy ?? null,
    })),
    whySelected: input.basis.selectedItems.map((item) => ({
      digest: item.digest,
      reason: input.basis.mode,
      query: input.basis.query,
    })),
    retrievalCaps: {
      maxItems: input.basis.maxItems,
      refCaps: input.basis.refs.map((ref) => ({
        ref: ref.ref,
        maxItems: ref.maxItems,
      })),
    },
    excludedSensitiveSources: input.basis.excludedRefs,
    writeTargets: input.basis.writeTargets,
  };
}

function effectivePromptContext(
  workflowContext: WorkflowContext,
  nodeContext: WorkflowNodeContextEnvelope | undefined,
): {
  mode: 'workflow_default' | 'node_envelope';
  refs: NormalizedContextRef[];
  excludedRefs: string[];
  maxItems: number | null;
  query?: string;
  writeTargets: unknown[];
} {
  const defaultRefs = normalizeRefs(workflowContext);
  const hasNodeEnvelope = Boolean(nodeContext);
  const include = nodeContext?.include ? normalizeRefs(nodeContext.include) : defaultRefs;
  const excludedRefs = normalizeRefs(nodeContext?.exclude ?? []).map((ref) => ref.ref);
  const excluded = new Set(excludedRefs);
  const refs = include.filter((ref) => !excluded.has(ref.ref));

  if (
    defaultRefs.length > 0 &&
    nodeContext?.include &&
    !(nodeContext.allow_expansion ?? nodeContext.allowExpansion)
  ) {
    const allowed = new Set(defaultRefs.map((ref) => ref.ref));
    const expanded = refs.filter((ref) => !allowed.has(ref.ref)).map((ref) => ref.ref);
    if (expanded.length > 0) {
      throw new Error(
        `Node context includes refs outside workflow defaults: ${expanded.join(', ')}. Set context.allow_expansion=true only with explicit policy approval.`,
      );
    }
  }

  return {
    mode: hasNodeEnvelope ? 'node_envelope' : 'workflow_default',
    refs,
    excludedRefs,
    maxItems: positiveInteger(nodeContext?.max_items ?? nodeContext?.maxItems),
    query: nodeContext?.query,
    writeTargets: nodeContext?.write_targets ?? nodeContext?.writeTargets ?? [],
  };
}

function formatPromptContextBlock(
  basis: NodeContextSelection['basis'],
  items: ResolvedContextItem[],
): string {
  return [
    '<viewport_context>',
    'Viewport selected the following node-scoped context. Use only this context basis for this workflow node and cite labels when relevant.',
    `Context basis id: ${basis.nodeId}`,
    '',
    ...items.map((item, index) =>
      [
        `## [context-${index + 1}] ${item.alias ?? item.provider_id} (${item.provider})`,
        `Source: ${safeContextSource(item)}`,
        `Digest: ${contextDigest(item)}`,
        `Title: ${item.title}`,
        '',
        item.body,
      ].join('\n'),
    ),
    '</viewport_context>',
  ].join('\n');
}

function normalizeRefs(refs: WorkflowContextNode['refs']): NormalizedContextRef[] {
  return (refs ?? []).map((ref): NormalizedContextRef => {
    if (typeof ref === 'string') {
      return { ref, required: false };
    }
    const concreteRef = ref.ref ?? ref.source ?? ref.package ?? ref.artifact;
    if (!concreteRef) {
      return { ref: '', required: ref.required === true };
    }
    return {
      ref: concreteRef,
      as: ref.as,
      required: ref.required === true,
      description: ref.description,
      refresh: ref.refresh,
      maxItems: positiveInteger(ref.max_items ?? ref.maxItems) ?? undefined,
    };
  }).filter((ref) => ref.ref.trim() !== '');
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
    normalized === provider.repo ||
    normalized === provider.ref ||
    normalized === `context://${provider.id}` ||
    normalized === `context://${provider.vault}` ||
    normalized === `context://vault/${provider.vault}` ||
    normalized === `source:${provider.id}` ||
    normalized === `package:${provider.id}` ||
    normalized === `provider://${provider.id}` ||
    normalized === `provider://${provider.vault}`
  );
}

function refMaxItemsForProvider(
  provider: SessionContextProviderManifest,
  refs: NormalizedContextRef[],
): number | null {
  const matching = refs.find((ref) => matchesProviderRef(provider, ref.ref));
  return matching?.maxItems ?? null;
}

function contextProviderCredentials(
  provider: SessionContextProviderManifest,
): { passphrase: string; recoveryCode: string } | undefined {
  const key = provider.vault ?? provider.id;
  const scopedPrefix = `VIEWPORT_CONTEXT_${envKey(key)}`;
  const passphrase =
    process.env[`${scopedPrefix}_PASSPHRASE`] ?? process.env.VIEWPORT_CONTEXT_PASSPHRASE;
  const recoveryCode =
    process.env[`${scopedPrefix}_RECOVERY_CODE`] ?? process.env.VIEWPORT_CONTEXT_RECOVERY_CODE;
  if (!passphrase || !recoveryCode) return undefined;
  return { passphrase, recoveryCode };
}

function envKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function metadataOnlyContextItem(item: ResolvedContextItem): Record<string, unknown> {
  return {
    id: item.id,
    provider_id: item.provider_id,
    provider: item.provider,
    privacy: item.privacy,
    title: item.title,
    digest: contextDigest(item),
    score: item.score ?? null,
    alias: item.alias ?? null,
    source: safeContextSource(item),
  };
}

function safeContextSource(item: ResolvedContextItem): string {
  const source = typeof item.source === 'string' && item.source.trim() !== '' ? item.source : null;
  if (!source) return item.provider_id;

  if (source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
    const normalized = source.replaceAll('\\', '/');
    const basename = normalized.split('/').filter(Boolean).at(-1);

    return basename ? `${item.provider_id}:${basename}` : item.provider_id;
  }

  return source;
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}
