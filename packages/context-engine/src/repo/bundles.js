const crypto = require('node:crypto');
const { canonicalize } = require('../crypto/canonical');
const { digest } = require('../crypto/envelope');
const {
  EMBEDDING_MODEL_DIGEST,
  EMBEDDING_MODEL_ID,
  rankEntries,
} = require('../store/local-semantic');

const RESOLVER = Object.freeze({
  kind: 'context-vault-poc',
  version: '0.0.1',
  vectorIndexEngine: 'sqlite-fts5+local-hash-embeddings',
  embeddingModelId: EMBEDDING_MODEL_ID,
  embeddingModelDigest: EMBEDDING_MODEL_DIGEST,
});

class ResolverPinMismatchError extends Error {
  constructor(mismatches) {
    super(`Context resolver pin mismatch: ${mismatches.map(({ field }) => field).join(', ')}`);
    this.name = 'ResolverPinMismatchError';
    this.code = 'CONTEXT_RESOLVER_PIN_MISMATCH';
    this.mismatches = mismatches;
  }
}

function resolverPinMismatches(pins) {
  const expected = {
    resolverVersion: RESOLVER.version,
    vectorIndexEngine: RESOLVER.vectorIndexEngine,
    embeddingModelId: RESOLVER.embeddingModelId,
    embeddingModelDigest: RESOLVER.embeddingModelDigest,
  };

  return Object.entries(expected)
    .filter(([field]) => Object.hasOwn(pins, field) && pins[field] !== expected[field])
    .map(([field, actual]) => ({
      field,
      expected: pins[field],
      actual,
    }));
}

function selectRows({ rows, query, maxItems }) {
  const rankedRows = query ? rankEntries(rows, query) : rows.map((entry) => ({ entry, score: null }));
  return rankedRows
    .filter(({ score }) => score === null || score > 0)
    .slice(0, maxItems ?? rankedRows.length)
    .map(({ entry, score }) => ({
      ...entry,
      retrieval_score: score,
    }));
}

function manifestItemForEntry(entry) {
  if (entry.scope === 'private') {
    return {
      entry_id: entry.id,
      version_id: entry.version_id,
      source: 'private://redacted',
      trust: entry.trust_state,
      scope: entry.scope,
      body_mode: 'redacted',
      title: 'Private context item',
      retrieval_score: entry.retrieval_score,
    };
  }

  return {
    entry_id: entry.id,
    version_id: entry.version_id,
    source: entry.source,
    trust: entry.trust_state,
    scope: entry.scope,
    body_mode: 'included',
    title: entry.title,
    retrieval_score: entry.retrieval_score,
  };
}

function normalizeBundleManifestForDigest(manifest) {
  const {
    digest: _digest,
    ...withoutDigest
  } = manifest;

  return {
    ...withoutDigest,
    bundle_id: 'deterministic',
    resolved_at: 'deterministic',
    override: manifest.override ? {
      ...manifest.override,
      created_at: 'deterministic',
    } : undefined,
  };
}

function digestBundleManifest(manifest) {
  return digest(canonicalize(normalizeBundleManifestForDigest(manifest)));
}

function buildContextBundle({
  actorName,
  rows,
  packs,
  target,
  includePrivate,
  pins,
  override,
  query,
  maxItems,
  offline,
  lastSyncAt,
  profileDescriptor = null,
}) {
  const mismatches = resolverPinMismatches(pins);
  if (mismatches.length > 0 && !override?.reason) {
    throw new ResolverPinMismatchError(mismatches);
  }

  const selectedRows = selectRows({ rows, query, maxItems });
  const items = selectedRows
    .map((entry) => manifestItemForEntry(entry))
    .sort((a, b) => `${a.entry_id}:${a.version_id}`.localeCompare(`${b.entry_id}:${b.version_id}`));

  const manifest = {
    apiVersion: 'viewport.context_bundle_manifest/v1',
    bundle_id: `ctxb_${crypto.randomUUID()}`,
    resolved_at: new Date().toISOString(),
    resolver: {
      kind: RESOLVER.kind,
      version: RESOLVER.version,
    },
    index: {
      engine: RESOLVER.vectorIndexEngine,
      embedding_model_id: RESOLVER.embeddingModelId,
      embedding_model_digest: RESOLVER.embeddingModelDigest,
    },
    request: { packs, target, include_private: includePrivate, pins, query, max_items: maxItems },
    profile: profileDescriptor,
    retrieval: {
      mode: query ? 'local-semantic' : 'all-approved',
      local_only: true,
      remote_plaintext_calls: 0,
    },
    offline: {
      active: Boolean(offline),
      last_sync_at: lastSyncAt,
    },
    override: override?.reason ? {
      reason: override.reason,
      actor_name: actorName,
      created_at: new Date().toISOString(),
      mismatches,
    } : undefined,
    items,
  };
  manifest.digest = digestBundleManifest(manifest);

  return {
    manifest,
    delivery: {
      items: selectedRows.map((entry) => ({
        id: entry.id,
        title: entry.title,
        body: entry.body,
        scope: entry.scope,
        trust: entry.trust_state,
      })),
    },
  };
}

module.exports = {
  RESOLVER,
  ResolverPinMismatchError,
  buildContextBundle,
  digestBundleManifest,
  normalizeBundleManifestForDigest,
};
