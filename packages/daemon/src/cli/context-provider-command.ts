import {
  resolveSessionResourceManifestSync,
  type SessionContextProviderManifest,
} from '../config-resolution/index.js';
import {
  resolveRepoDocsProvider,
  type RepoDocsContextItem,
} from '../context-providers/repo-docs-provider.js';
import { resolveContextBundle, type ContextBundle } from '../context/local-edge-store.js';
import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  fallbackProposeProvider,
  proposeToViewportVaultProvider,
} from './context-provider-propose.js';

type ContextProviderResult = {
  id: string;
  provider_id: string;
  provider: string;
  privacy: string;
  title: string;
  body: string;
  digest?: string;
  source?: string;
  score?: number;
};

type ProviderConsulted = {
  id: string;
  provider: string;
  privacy: string;
  status: 'ok' | 'skipped' | 'error';
  duration_ms: number;
  reason?: string;
  result_count?: number;
};

const DEFAULT_VAULT_MAX_ITEMS = 25;
const MAX_VAULT_ITEMS_PER_PROVIDER = 50;
const ASSUMED_VAULT_ITEM_BYTES = 2048;

export async function contextSearch(): Promise<void> {
  const query = getFlag('query') ?? '';
  const providerId = getFlag('provider');
  const manifest = resolveSessionResourceManifestSync({ workingDirectory: getPathFlag() });
  const consulted: ProviderConsulted[] = [];
  const results: ContextProviderResult[] = [];

  for (const provider of orderedProviders(
    manifest.contract.contextProviders,
    manifest.contract.contextResolution.order,
  )) {
    if (providerId && provider.id !== providerId) continue;
    const started = Date.now();
    try {
      if (!provider.capabilities.includes('search')) {
        consulted.push(providerConsulted(provider, started, 'skipped', 'capability_not_supported'));
        continue;
      }
      const providerResults = await searchProvider(
        provider,
        query,
        manifest.contract.contextResolution.sizeBudgetBytes,
      );
      results.push(...providerResults);
      consulted.push(providerConsulted(provider, started, 'ok', undefined, providerResults.length));
    } catch (error) {
      consulted.push(providerConsulted(provider, started, 'error', errorMessage(error)));
    }
  }

  const output = {
    schema_version: 'viewport.cli.context_search/v1',
    command: 'context search',
    ok: consulted.every((provider) => provider.status !== 'error'),
    query,
    manifest_digest: manifest.manifestDigest,
    providers_consulted: consulted,
    results,
  };

  if (isJsonMode()) {
    printJson(output);
    return;
  }
  console.log(`Context search: ${results.length} result(s)`);
  for (const result of results) {
    console.log('');
    console.log(`# ${result.title}`);
    console.log(`Provider: ${result.provider_id} (${result.provider})`);
    console.log(result.body);
  }
}

export async function contextGet(): Promise<void> {
  const entryId = getArgs()[2];
  if (!entryId || entryId.startsWith('--')) {
    throw new Error('Usage: vpd context get <entry-id> [--path <path>] [--provider <id>] [--json]');
  }
  const providerId = getFlag('provider') ?? providerIdFromEntryId(entryId);
  const manifest = resolveSessionResourceManifestSync({ workingDirectory: getPathFlag() });
  const providers = orderedProviders(
    manifest.contract.contextProviders,
    manifest.contract.contextResolution.order,
  ).filter((provider) => !providerId || provider.id === providerId);

  for (const provider of providers) {
    if (!provider.capabilities.includes('get')) continue;
    const results = await searchProvider(
      provider,
      '',
      manifest.contract.contextResolution.sizeBudgetBytes,
    );
    const entry = results.find((result) => result.id === entryId);
    if (!entry) continue;
    if (isJsonMode()) {
      printJson({
        schema_version: 'viewport.cli.context_get/v1',
        command: 'context get',
        ok: true,
        manifest_digest: manifest.manifestDigest,
        entry,
      });
      return;
    }
    console.log(`# ${entry.title}`);
    console.log(`Provider: ${entry.provider_id} (${entry.provider})`);
    console.log(entry.body);
    return;
  }

  throw new Error(`Context entry not found: ${entryId}`);
}

export async function contextProviderPropose(): Promise<void> {
  const providerId = requiredFlag(
    'provider',
    'vpd context propose --provider <id> --title <text> --body <text>',
  );
  const manifest = resolveSessionResourceManifestSync({ workingDirectory: getPathFlag() });
  const provider = manifest.contract.contextProviders.find(
    (candidate) => candidate.id === providerId,
  );
  if (!provider) {
    throw new Error(`Context provider not found in resolved contract: ${providerId}`);
  }
  if (!provider.capabilities.includes('propose')) {
    const fallbackProvider = fallbackProposeProvider(
      manifest.contract.contextProviders,
      manifest.contract.contextResolution.proposeFallbackProvider,
      provider.id,
    );
    if (fallbackProvider) {
      const candidate = await proposeToViewportVaultProvider(fallbackProvider, {
        ...proposeInput(manifest.manifestDigest),
        sourceProvider: provider,
        source: getFlag('source'),
      });
      if (isJsonMode()) {
        printJson({
          schema_version: 'viewport.cli.context_propose/v1',
          command: 'context propose',
          ok: true,
          requested_provider_id: provider.id,
          requested_provider: provider.provider,
          provider_id: fallbackProvider.id,
          provider: fallbackProvider.provider,
          fallback_provider_id: fallbackProvider.id,
          fallback_reason: 'provider_does_not_support_propose',
          status: 'pending_review',
          candidate_id: candidate.id,
          payload_digest: candidate.bodyDigest,
          manifest_digest: manifest.manifestDigest,
          message: 'Context candidate queued for human review through fallback provider.',
        });
        return;
      }
      console.log(`Context candidate proposed: ${candidate.id}`);
      console.log(`Requested provider: ${provider.id}`);
      console.log(`Fallback provider: ${fallbackProvider.id}`);
      console.log('Status: pending review');
      return;
    }
    const output = {
      schema_version: 'viewport.cli.context_propose/v1',
      command: 'context propose',
      ok: false,
      provider_id: provider.id,
      provider: provider.provider,
      status: 'queued_manual_action',
      reason: 'provider_does_not_support_propose',
      manifest_digest: manifest.manifestDigest,
    };
    if (isJsonMode()) {
      printJson(output);
      return;
    }
    console.log(`Provider ${provider.id} does not support proposed context.`);
    return;
  }
  if (provider.provider !== 'viewport-vault' || !provider.vault) {
    throw new Error(`Provider ${provider.id} does not have a v1 propose adapter.`);
  }

  const candidate = await proposeToViewportVaultProvider(
    provider,
    proposeInput(manifest.manifestDigest),
  );

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_propose/v1',
      command: 'context propose',
      ok: true,
      provider_id: provider.id,
      provider: provider.provider,
      status: 'pending_review',
      candidate_id: candidate.id,
      payload_digest: candidate.bodyDigest,
      manifest_digest: manifest.manifestDigest,
      message: 'Context candidate queued for human review.',
    });
    return;
  }
  console.log(`Context candidate proposed: ${candidate.id}`);
  console.log(`Provider: ${provider.id}`);
  console.log('Status: pending review');
}

async function searchProvider(
  provider: SessionContextProviderManifest,
  query: string,
  sizeBudgetBytes?: number,
): Promise<ContextProviderResult[]> {
  if (provider.provider === 'repo-docs') {
    const items = await resolveRepoDocsProvider({ provider, query, sizeBudgetBytes });
    return items.map(repoDocsResult);
  }
  if (provider.provider === 'viewport-vault') {
    if (!provider.vault) throw new Error('viewport-vault provider missing vault id');
    const bundle = await resolveContextBundle({
      contextResourceId: provider.vault,
      actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
      query,
      maxItems: maxItemsForBudget(sizeBudgetBytes),
      credentials: optionalCredentials(),
      home: getFlag('home'),
    });
    return bundleResults(provider, bundle);
  }
  return [];
}

function maxItemsForBudget(sizeBudgetBytes?: number): number {
  if (!sizeBudgetBytes || sizeBudgetBytes <= 0) return DEFAULT_VAULT_MAX_ITEMS;
  return Math.max(
    1,
    Math.min(MAX_VAULT_ITEMS_PER_PROVIDER, Math.floor(sizeBudgetBytes / ASSUMED_VAULT_ITEM_BYTES)),
  );
}

function repoDocsResult(item: RepoDocsContextItem): ContextProviderResult {
  return {
    id: item.id,
    provider_id: item.providerId,
    provider: item.providerKind,
    privacy: item.privacy,
    title: item.title,
    body: item.body,
    digest: item.digest,
    source: item.sourcePath,
  };
}

function bundleResults(
  provider: SessionContextProviderManifest,
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

function orderedProviders(
  providers: SessionContextProviderManifest[],
  order: string[] | undefined,
): SessionContextProviderManifest[] {
  if (!order?.length) return providers;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const ordered = order.flatMap((id) => {
    const provider = byId.get(id);
    return provider ? [provider] : [];
  });
  const remainder = providers.filter((provider) => !order.includes(provider.id));
  return [...ordered, ...remainder];
}

function providerConsulted(
  provider: SessionContextProviderManifest,
  started: number,
  status: ProviderConsulted['status'],
  reason?: string,
  resultCount?: number,
): ProviderConsulted {
  return {
    id: provider.id,
    provider: provider.provider,
    privacy: provider.privacy,
    status,
    duration_ms: Math.max(0, Date.now() - started),
    ...(reason ? { reason } : {}),
    ...(resultCount !== undefined ? { result_count: resultCount } : {}),
  };
}

function getPathFlag(): string {
  return getFlag('path') ?? getFlag('cwd') ?? process.cwd();
}

function providerIdFromEntryId(entryId: string): string | undefined {
  const index = entryId.indexOf(':');
  return index > 0 ? entryId.slice(0, index) : undefined;
}

function optionalCredentials(): { passphrase: string; recoveryCode: string } {
  return {
    passphrase: getFlag('passphrase') ?? '',
    recoveryCode: getFlag('recovery-code') ?? '',
  };
}

function parseSourceKind(raw: string | undefined): 'workflow' | 'plan' | 'integration' | undefined {
  if (!raw) return undefined;
  if (raw === 'workflow' || raw === 'plan' || raw === 'integration') return raw;
  throw new Error(`Unsupported context candidate source kind: ${raw}`);
}

function proposeInput(manifestDigest: string) {
  return {
    manifestDigest,
    actorName: getFlag('actor') ?? getFlag('device') ?? 'local-device',
    title: requiredFlag(
      'title',
      'vpd context propose --provider <id> --title <text> --body <text>',
    ),
    body: requiredFlag('body', 'vpd context propose --provider <id> --title <text> --body <text>'),
    source: getFlag('source'),
    sourceKind: parseSourceKind(getFlag('source-kind')) ?? 'workflow',
    credentials: optionalCredentials(),
    home: getFlag('home'),
  };
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(`${usage} (missing --${name})`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
