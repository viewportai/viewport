import {
  resolveSessionResourceManifestSync,
  type SessionContextProviderManifest,
} from '../config-resolution/index.js';
import { contextProviderAdapterFor } from '../context-providers/registry.js';
import type { ContextProviderResult } from '../context-providers/types.js';
import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  fallbackProposeProvider,
  proposeToViewportVaultProvider,
} from './context-provider-propose.js';

type ProviderConsulted = {
  id: string;
  provider: string;
  privacy: string;
  status: 'ok' | 'skipped' | 'error';
  duration_ms: number;
  reason?: string;
  result_count?: number;
};

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
      const adapter = contextProviderAdapterFor(provider);
      if (!adapter?.search) {
        consulted.push(providerConsulted(provider, started, 'skipped', 'adapter_not_implemented'));
        continue;
      }
      const providerResults = await adapter.search({
        provider,
        query,
        sizeBudgetBytes: manifest.contract.contextResolution.sizeBudgetBytes,
        actorName: getActorName(),
        credentials: optionalCredentials(),
        home: getFlag('home'),
      });
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
    const adapter = contextProviderAdapterFor(provider);
    const entry = await adapter?.get?.({
      provider,
      entryId,
      query: '',
      sizeBudgetBytes: manifest.contract.contextResolution.sizeBudgetBytes,
      actorName: getActorName(),
      credentials: optionalCredentials(),
      home: getFlag('home'),
    });
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
  const manifest = resolveSessionResourceManifestSync({ workingDirectory: getPathFlag() });
  const providerId = getFlag('provider') ?? defaultProposeProviderId(manifest);
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
  if (!contextProviderAdapterFor(provider)?.propose) {
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

function defaultProposeProviderId(manifest: {
  contract: {
    contextProviders: SessionContextProviderManifest[];
    contextResolution: { proposeFallbackProvider?: string };
  };
}): string {
  const configuredFallback = manifest.contract.contextResolution.proposeFallbackProvider;
  if (configuredFallback) {
    const provider = manifest.contract.contextProviders.find(
      (candidate) => candidate.id === configuredFallback,
    );
    if (!provider) {
      throw new Error(
        `Configured propose fallback provider not found in resolved contract: ${configuredFallback}`,
      );
    }
    return provider.id;
  }

  const capable = manifest.contract.contextProviders.filter((provider) =>
    provider.capabilities.includes('propose'),
  );
  if (capable.length === 1) return capable[0]!.id;
  if (capable.length > 1) {
    throw new Error(
      `Multiple context providers can accept proposals (${capable
        .map((provider) => provider.id)
        .join(', ')}). Pass --provider <id>.`,
    );
  }

  throw new Error(
    'No context provider in the resolved contract can accept proposals. Add a viewport-vault provider or pass --context <id> for the legacy local path.',
  );
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

function getActorName(): string {
  return getFlag('actor') ?? getFlag('device') ?? 'local-device';
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
      'vpd context propose [--provider <id>] --title <text> --body <text>',
    ),
    body: requiredFlag(
      'body',
      'vpd context propose [--provider <id>] --title <text> --body <text>',
    ),
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
