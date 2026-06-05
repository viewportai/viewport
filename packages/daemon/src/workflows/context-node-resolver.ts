import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { contextProviderAdapterFor } from '../context-providers/registry.js';
import type { ContextProviderResult } from '../context-providers/types.js';
import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import type {
  PlatformContextSourcePolicy,
  PlatformSessionMemoryRetrieval,
  WorkflowPlatformContextClient,
} from './platform-context-client.js';
import type {
  WorkflowContext,
  WorkflowContextDefaults,
  WorkflowContextNode,
  WorkflowContextReceiptRecord,
  WorkflowNodeContextEnvelope,
  WorkflowRunRecord,
} from './types.js';
import { addEvent, renderOptionalTemplate, renderTemplate } from './runtime-helpers.js';
import { contextAuthorityDenial } from './workflow-authority-contract.js';

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
  const refs = await renderContextRefs(normalizeRefs(node.refs ?? []), run);
  const query = await renderOptionalTemplate(node.query, run);
  const providers = selectProviders(run.resourceManifest?.contract.contextProviders ?? [], refs);
  const denied = providers
    .map(({ provider }) => contextAuthorityDenial(run, nodeId, provider))
    .find((entry) => entry !== null);
  if (denied) {
    addEvent(run, 'context-blocked', denied.detail, { workflow_authority_denial: denied }, nodeId);
    throw new Error(denied.detail);
  }
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
  workflowContext?: WorkflowContext | WorkflowContextDefaults;
  nodeContext?: WorkflowNodeContextEnvelope;
  prompt: string;
  platformContextClient?: WorkflowPlatformContextClient;
}): Promise<NodeContextSelection> {
  const effective = await effectivePromptContext(
    input.workflowContext ?? [],
    input.nodeContext,
    input.run,
  );
  if (effective.refs.length === 0) {
    return emptyNodeContextBasis(input.nodeId);
  }

  const query = await renderOptionalTemplate(effective.query ?? input.prompt, input.run);
  const platformResolution = await input.platformContextClient?.resolveNodePolicy({
    run: input.run,
    nodeId: input.nodeId,
    query: query ?? '',
    maxSnippets: effective.maxItems,
  });
  const platformPolicies = platformResolution?.source_policies ?? [];
  const sessionMemoryRefs = effective.refs.filter(isSessionMemoryRef);
  const workflowContextItems = workflowProducedContextItems(effective.refs, input.run);
  const providerRefs = effective.refs.filter(
    (ref) => !workflowProducedContextRef(ref, input.run) && !isSessionMemoryRef(ref),
  );
  const providers =
    platformPolicies.length > 0
      ? platformPolicyProviders(
          input.run.resourceManifest?.contract.contextProviders ?? [],
          platformPolicies,
          input.run,
        )
      : contextRefProviders(
          input.run.resourceManifest?.contract.contextProviders ?? [],
          providerRefs,
          input.run,
        );
  const denied = providers
    .map(({ provider }) => contextAuthorityDenial(input.run, input.nodeId, provider))
    .find((entry) => entry !== null);
  if (denied) {
    addEvent(
      input.run,
      'node-context-blocked',
      denied.detail,
      { workflow_authority_denial: denied },
      input.nodeId,
    );
    throw new Error(denied.detail);
  }
  const missingRequired = missingRequiredRefs(providerRefs, providers);
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

  const sessionMemoryItems = await resolveSessionMemoryContext({
    run: input.run,
    nodeId: input.nodeId,
    refs: sessionMemoryRefs,
    query: query ?? '',
    maxItems: effective.maxItems,
    platformContextClient: input.platformContextClient,
    skipped,
  });

  const combinedItems = [...workflowContextItems, ...items, ...sessionMemoryItems];
  const selectedItems = combinedItems.slice(0, effective.maxItems ?? combinedItems.length);
  const contextReceipts = buildContextReceipts({
    run: input.run,
    nodeId: input.nodeId,
    query,
    refs: effective.refs,
    providers,
    items: selectedItems,
  });
  input.run.contextReceipts = [
    ...(input.run.contextReceipts ?? []).filter(
      (receipt) => receipt.usedBy.nodeId !== input.nodeId,
    ),
    ...contextReceipts,
  ];

  if (input.platformContextClient && platformPolicies.length > 0) {
    for (const policy of platformPolicies) {
      const policyItems = selectedItems.filter((item) =>
        providerMatchesPlatformPolicy(itemProviderForItem(item, providers), policy),
      );
      await input.platformContextClient.reportCustomerManagedReceipt({
        run: input.run,
        nodeId: input.nodeId,
        policy,
        query: query ?? '',
        items: policyItems,
      });
    }
  }

  const receiptQuery = sanitizeContextQueryForReceipt(query ?? null);
  const basis: NodeContextSelection['basis'] = {
    schema: 'viewport.node_context_basis/v1',
    nodeId: input.nodeId,
    mode: effective.mode,
    query: receiptQuery,
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

async function resolveSessionMemoryContext(input: {
  run: WorkflowRunRecord;
  nodeId: string;
  refs: NormalizedContextRef[];
  query: string;
  maxItems: number | null;
  platformContextClient?: WorkflowPlatformContextClient;
  skipped: Array<{ providerId: string; reason: string }>;
}): Promise<ResolvedContextItem[]> {
  if (input.refs.length === 0) return [];

  const required = input.refs.some((ref) => ref.required);
  if (!input.platformContextClient) {
    input.skipped.push({ providerId: 'session_memory', reason: 'platform_context_unavailable' });
    if (required) {
      throw new Error(
        `Prompt node ${input.nodeId} requires Product20 session memory, but no platform context client is configured.`,
      );
    }
    return [];
  }

  const limit =
    positiveInteger(input.refs.map((ref) => ref.maxItems).find((value) => value !== undefined)) ??
    input.maxItems ??
    10;

  try {
    const result = await input.platformContextClient.retrieveSessionMemory({
      run: input.run,
      query: input.query,
      limit,
    });
    if (!result?.retrieval) {
      input.skipped.push({ providerId: 'session_memory', reason: 'no_retrieval_returned' });
      return [];
    }

    const items = sessionMemoryRetrievalItems(result, input.refs);
    const retrieval = result.retrieval;
    addEvent(
      input.run,
      'session-memory-retrieved',
      `Node ${input.nodeId} retrieved ${items.length} Product20 session memory item${items.length === 1 ? '' : 's'}`,
      {
        schema: 'viewport.daemon_session_memory_retrieved/v1',
        receipt_id: stringValue(pathValue(result.receipt, ['id'])),
        receipt_digest: stringValue(pathValue(result.receipt, ['digest'])),
        working_set_receipt_id: stringValue(
          pathValue(retrieval, ['working_set', 'receipt_id']),
        ),
        query_digest: stringValue(pathValue(retrieval, ['query', 'digest'])),
        result_count: items.length,
        raw_query_returned: pathValue(retrieval, ['query', 'raw_query_returned']) === true,
        raw_memory_plaintext_returned:
          pathValue(retrieval, ['access_model', 'raw_memory_plaintext_returned']) === true,
        learned_state_expands_access:
          pathValue(retrieval, ['access_model', 'learned_state_expands_access']) === true,
      },
      input.nodeId,
    );

    return items;
  } catch (error) {
    input.skipped.push({ providerId: 'session_memory', reason: 'retrieval_failed' });
    addEvent(
      input.run,
      'session-memory-retrieval-failed',
      `Node ${input.nodeId} could not retrieve Product20 session memory.`,
      {
        schema: 'viewport.daemon_session_memory_retrieval_failed/v1',
        error: error instanceof Error ? error.message : String(error),
      },
      input.nodeId,
    );
    if (required) throw error;
    return [];
  }
}

function sessionMemoryRetrievalItems(
  result: PlatformSessionMemoryRetrieval,
  refs: NormalizedContextRef[],
): ResolvedContextItem[] {
  const retrieval = result.retrieval ?? {};
  const rows = Array.isArray(retrieval['results']) ? retrieval['results'] : [];
  const alias = refs.find((ref) => ref.as)?.as;

  return rows
    .map((row, index): ResolvedContextItem | null => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const record = row as Record<string, unknown>;
      const digest =
        stringValue(record['memory_entry_digest']) ??
        stringValue(record['digest']) ??
        stringValue(record['content_digest']) ??
        `sha256:${createHash('sha256').update(JSON.stringify(metadataSafeMemoryResult(record))).digest('hex')}`;
      const sourceId = stringValue(record['context_source_id']) ?? 'session_memory';
      const title = stringValue(record['title']) ?? `Session memory ${index + 1}`;
      const team = objectValue(record['retrieved_for_team']);
      const body = [
        'Product20 session memory result (metadata only).',
        `Context source: ${sourceId}`,
        `Memory digest: ${digest}`,
        `Title: ${title}`,
        `Score: ${numberValue(record['score']) ?? 'unknown'}`,
        team ? `Retrieved for team: ${stringValue(team['name']) ?? stringValue(team['slug']) ?? stringValue(team['id']) ?? 'unknown'}` : null,
        'Raw memory plaintext was not returned by the platform memory provider.',
      ]
        .filter((line): line is string => typeof line === 'string')
        .join('\n');

      return {
        id: stringValue(record['id']) ?? `session-memory-${index + 1}`,
        provider_id: sourceId,
        provider: 'session-memory',
        privacy: 'platform_governed_metadata_only',
        title,
        body,
        digest,
        source: `session-memory:${sourceId}`,
        ...(numberValue(record['score']) !== null ? { score: numberValue(record['score']) ?? undefined } : {}),
        alias,
      };
    })
    .filter((item): item is ResolvedContextItem => item !== null);
}

export function sanitizeContextQueryForReceipt(query: string | null): string | null {
  if (query === null) return null;

  return query
    .replace(
      /("(?:token|access_token|refresh_token|bot_token|api_key|client_secret|signing_secret|private_key)"\s*:\s*")([^"]*)(")/gi,
      '$1[redacted]$3',
    )
    .replace(
      /('(?:token|access_token|refresh_token|bot_token|api_key|client_secret|signing_secret|private_key)'\s*:\s*')([^']*)(')/gi,
      '$1[redacted]$3',
    )
    .replace(
      /\b((?:xox[baprs]-|gh[ps]_|vp(?:claim|relay|runner)_[A-Za-z0-9_-]*|slack_[A-Za-z0-9_-]*)(?:[A-Za-z0-9_-]+)?)/g,
      '[redacted-token]',
    );
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

async function effectivePromptContext(
  workflowContext: WorkflowContext | WorkflowContextDefaults,
  nodeContext: WorkflowNodeContextEnvelope | undefined,
  run: WorkflowRunRecord,
): Promise<{
  mode: 'workflow_default' | 'node_envelope';
  refs: NormalizedContextRef[];
  excludedRefs: string[];
  maxItems: number | null;
  query?: string;
  writeTargets: unknown[];
}> {
  const workflowSources = Array.isArray(workflowContext)
    ? workflowContext
    : (workflowContext.sources ?? []);
  const defaultRefs = await renderContextRefs(normalizeRefs(workflowSources), run);
  const hasNodeEnvelope = Boolean(nodeContext);
  const include = nodeContext?.include
    ? await renderContextRefs(normalizeRefs(nodeContext.include), run)
    : defaultRefs;
  const excludedRefs = (
    await renderContextRefs(normalizeRefs(nodeContext?.exclude ?? []), run)
  ).map((ref) => ref.ref);
  const excluded = new Set(excludedRefs);
  const refs = include.filter((ref) => !excluded.has(ref.ref));

  if (
    defaultRefs.length > 0 &&
    nodeContext?.include &&
    !(nodeContext.allow_expansion ?? nodeContext.allowExpansion)
  ) {
    const allowed = new Set(defaultRefs.map((ref) => ref.ref));
    const expanded = refs
      .filter((ref) => !allowed.has(ref.ref) && !workflowProducedContextRef(ref, run))
      .map((ref) => ref.ref);
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
    writeTargets: await renderContextWriteTargets(
      nodeContext?.write_targets ?? nodeContext?.writeTargets ?? [],
      run,
    ),
  };
}

async function renderContextRefs(
  refs: NormalizedContextRef[],
  run: WorkflowRunRecord,
): Promise<NormalizedContextRef[]> {
  const rendered = await Promise.all(
    refs.map(async (ref) => ({
      ...ref,
      ref: await renderTemplate(ref.ref, run),
      as: ref.as !== undefined ? await renderTemplate(ref.as, run) : undefined,
      description:
        ref.description !== undefined ? await renderTemplate(ref.description, run) : undefined,
    })),
  );
  return rendered.filter((ref) => ref.ref.trim() !== '');
}

async function renderContextWriteTargets(
  targets: unknown[],
  run: WorkflowRunRecord,
): Promise<unknown[]> {
  return await Promise.all(targets.map((target) => renderContextWriteTarget(target, run)));
}

async function renderContextWriteTarget(target: unknown, run: WorkflowRunRecord): Promise<unknown> {
  if (typeof target === 'string') {
    return await renderTemplate(target, run);
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return target;
  }

  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    rendered[key] = typeof value === 'string' ? await renderTemplate(value, run) : value;
  }
  return rendered;
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
  return (refs ?? [])
    .map((ref): NormalizedContextRef => {
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
    })
    .filter((ref) => ref.ref.trim() !== '');
}

function isSessionMemoryRef(ref: NormalizedContextRef): boolean {
  return [
    'session_memory',
    'platform://session-memory',
    'viewport://session-memory',
    'memory://session',
    'memory://agent-session',
  ].includes(ref.ref.trim());
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

function contextRefProviders(
  providers: SessionContextProviderManifest[],
  refs: NormalizedContextRef[],
  run: WorkflowRunRecord,
): Array<{ provider: SessionContextProviderManifest; alias?: string }> {
  const selected = selectProviders(providers, refs);
  const seen = new Set(selected.map(({ provider }) => provider.id));
  for (const ref of refs) {
    if (selectedProviderMatches(ref.ref, seen, selected)) continue;
    const provider = providerFromGitRef(ref.ref, run, ref.required);
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    selected.push({ provider, alias: ref.as });
  }
  return selected;
}

function selectProvidersForPolicies(
  providers: SessionContextProviderManifest[],
  policies: PlatformContextSourcePolicy[],
): Array<{ provider: SessionContextProviderManifest; alias?: string }> {
  const selected: Array<{ provider: SessionContextProviderManifest; alias?: string }> = [];
  const seen = new Set<string>();
  for (const policy of policies) {
    const provider = providers.find((candidate) =>
      providerMatchesPlatformPolicy(candidate, policy),
    );
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    selected.push({ provider, alias: policy.context_source_name });
  }
  return selected;
}

function platformPolicyProviders(
  providers: SessionContextProviderManifest[],
  policies: PlatformContextSourcePolicy[],
  run: WorkflowRunRecord,
): Array<{ provider: SessionContextProviderManifest; alias?: string }> {
  const selected = selectProvidersForPolicies(providers, policies);
  const seen = new Set(selected.map(({ provider }) => provider.id));
  for (const policy of policies) {
    if (seen.has(policy.context_source_id)) continue;
    const provider = providerFromPlatformPolicy(policy, run);
    if (!provider) continue;
    seen.add(provider.id);
    selected.push({ provider, alias: policy.context_source_name });
  }
  return selected;
}

function providerFromPlatformPolicy(
  policy: PlatformContextSourcePolicy,
  run: WorkflowRunRecord,
): SessionContextProviderManifest | null {
  if (policy.provider_type !== 'git') return null;
  return providerFromGitRef(policy.external_ref, run, false, policy.context_source_id);
}

function providerFromGitRef(
  ref: string,
  run: WorkflowRunRecord,
  required: boolean,
  id?: string,
): SessionContextProviderManifest | null {
  const gitRef = parseGitSourceRef(ref);
  if (!gitRef) return null;

  const localPath = path.resolve(run.directoryPath, gitRef.path);
  const localFileExists = isSafeChild(run.directoryPath, localPath) && existsSync(localPath);
  return {
    id: id ?? ref,
    provider: localFileExists ? 'repo-docs' : 'github-repo',
    required,
    privacy: localFileExists ? 'local_only' : 'third_party_terms',
    capabilities: ['search', 'get'],
    sourceConfigPath: path.join(run.directoryPath, '.viewport', 'platform-context.yaml'),
    repo: gitRef.repo,
    ...(localFileExists ? { ref } : { branch: 'main' }),
    paths: [gitRef.path],
    resolution: 'requested_unverified',
  };
}

function itemProviderForItem(
  item: ResolvedContextItem,
  providers: Array<{ provider: SessionContextProviderManifest }>,
): SessionContextProviderManifest | undefined {
  return providers.find(({ provider }) => provider.id === item.provider_id)?.provider;
}

function providerMatchesPlatformPolicy(
  provider: SessionContextProviderManifest | undefined,
  policy: PlatformContextSourcePolicy,
): boolean {
  if (!provider) return false;
  const candidates = [
    policy.context_source_id,
    policy.external_ref,
    policy.source_url ?? undefined,
    `context://${policy.context_source_id}`,
    `source:${policy.context_source_id}`,
    `provider://${policy.context_source_id}`,
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '');
  if (candidates.some((candidate) => matchesProviderRef(provider, candidate))) return true;

  const gitRef = parseGitSourceRef(policy.external_ref);
  if (gitRef && provider.provider === 'github-repo') {
    const repo = provider.repo?.replace(/\.git$/, '');
    const remote = provider.remote?.replace(/\.git$/, '');
    return repo === gitRef.repo || remote?.includes(gitRef.repo) === true;
  }

  if (policy.provider_type === 'git' && provider.provider === 'repo-docs') {
    return (
      provider.paths?.some((path) => gitRef?.path.startsWith(path.replace(/\*\*\/\*\.md$/, ''))) ??
      false
    );
  }

  return false;
}

function parseGitSourceRef(ref: string): { repo: string; path: string } | null {
  const match = /^git:\/\/([^/]+\/[^/]+)\/(.+)$/.exec(ref.trim());
  if (!match) return null;
  return { repo: match[1] ?? '', path: match[2] ?? '' };
}

function isSafeChild(baseDirectory: string, candidate: string): boolean {
  const relative = path.relative(baseDirectory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function workflowProducedContextItems(
  refs: NormalizedContextRef[],
  run: WorkflowRunRecord,
): ResolvedContextItem[] {
  return refs.flatMap((ref): ResolvedContextItem[] => {
    const artifact = workflowProducedContextRef(ref, run);
    if (!artifact) return [];
    const state = run.nodes[artifact.nodeId];
    const body = state?.output;
    if (typeof body !== 'string' || body.trim() === '') return [];

    return [
      {
        id: `workflow-artifact:${artifact.nodeId}:${artifact.name}`,
        provider_id: ref.ref,
        provider: 'workflow-artifact',
        privacy: 'workflow_internal',
        title:
          artifact.name === 'approved_body'
            ? `Approved body from ${artifact.nodeId}`
            : `Output from ${artifact.nodeId}`,
        body,
        source: `workflow://${run.id}/nodes/${artifact.nodeId}/${artifact.name}`,
      },
    ];
  });
}

function workflowProducedContextRef(
  ref: NormalizedContextRef,
  run: WorkflowRunRecord,
): { nodeId: string; name: string } | null {
  const match = /^([A-Za-z0-9_-][A-Za-z0-9._/-]*)\.(approved_body|output)$/.exec(ref.ref.trim());
  if (!match?.[1] || !match[2]) return null;

  const state = run.nodes[match[1]];
  if (!state || state.status !== 'completed') return null;
  if (typeof state.output !== 'string' || state.output.trim() === '') return null;

  return { nodeId: match[1], name: match[2] };
}

function matchesProviderRef(provider: SessionContextProviderManifest, ref: string): boolean {
  const normalized = ref.trim();
  const gitRef = parseGitSourceRef(normalized);
  if (gitRef && provider.provider === 'github-repo') {
    const repo = provider.repo?.replace(/\.git$/, '');
    const remote = provider.remote?.replace(/\.git$/, '');
    const repoMatches = repo === gitRef.repo || remote?.includes(gitRef.repo) === true;
    if (!repoMatches) return false;
    if (!provider.paths || provider.paths.length === 0) return true;
    return provider.paths.some((path) => providerPathMatchesGitRefPath(path, gitRef.path));
  }

  if (gitRef && provider.provider === 'repo-docs') {
    if (!provider.paths || provider.paths.length === 0) return true;
    return provider.paths.some((path) => providerPathMatchesGitRefPath(path, gitRef.path));
  }

  if (gitRef && provider.paths?.some((path) => providerPathMatchesGitRefPath(path, gitRef.path))) {
    return true;
  }

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

function providerPathMatchesGitRefPath(pattern: string, gitPath: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedPath = gitPath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalizedPattern === normalizedPath) return true;

  const wildcardIndex = normalizedPattern.search(/[*]/);
  if (wildcardIndex === -1) {
    return normalizedPath.startsWith(normalizedPattern.replace(/\/+$/, '') + '/');
  }

  const literalPrefix = normalizedPattern.slice(0, wildcardIndex);
  const directoryPrefix = literalPrefix.slice(0, literalPrefix.lastIndexOf('/') + 1);
  return directoryPrefix === '' || normalizedPath.startsWith(directoryPrefix);
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
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
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

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pathValue(value: unknown, pathSegments: string[]): unknown {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function metadataSafeMemoryResult(record: Record<string, unknown>): Record<string, unknown> {
  return {
    context_source_id: stringValue(record['context_source_id']) ?? null,
    memory_entry_digest: stringValue(record['memory_entry_digest']) ?? null,
    digest: stringValue(record['digest']) ?? null,
    title: stringValue(record['title']) ?? null,
    score: numberValue(record['score']),
  };
}
