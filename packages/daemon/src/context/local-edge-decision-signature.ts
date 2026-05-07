import crypto from 'node:crypto';
import type { ContextCandidateDecisionPullRecord } from './local-edge-types.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyContextCandidateDecision(record: ContextCandidateDecisionPullRecord): void {
  const signature = record.platform_signature;
  if (!signature) {
    throw new Error(`Context candidate decision ${record.id} is missing a platform signature`);
  }
  if (signature.algorithm !== 'Ed25519') {
    throw new Error(`Context candidate decision ${record.id} used unsupported signature algorithm`);
  }

  const publicKeyRaw = Buffer.from(signature.public_key, 'base64');
  const signatureRaw = Buffer.from(signature.signature, 'base64');
  if (publicKeyRaw.length !== 32) {
    throw new Error(`Context candidate decision ${record.id} had an invalid platform public key`);
  }
  if (signatureRaw.length !== 64) {
    throw new Error(`Context candidate decision ${record.id} had an invalid platform signature`);
  }

  const payload = canonicalJson(unsignedDecisionRecord(record));
  const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  if (signature.signed_payload_digest !== digest) {
    throw new Error(`Context candidate decision ${record.id} signature digest mismatch`);
  }

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
    format: 'der',
    type: 'spki',
  });

  if (!crypto.verify(null, Buffer.from(payload), publicKey, signatureRaw)) {
    throw new Error(`Context candidate decision ${record.id} platform signature invalid`);
  }
}

function unsignedDecisionRecord(
  record: ContextCandidateDecisionPullRecord,
): Record<string, unknown> {
  return {
    schema_version: record.schema_version,
    id: record.id,
    inbox_item_id: record.inbox_item_id ?? null,
    repo_id: record.repo_id,
    candidate_event_id: record.candidate_event_id,
    payload_digest: record.payload_digest ?? null,
    decision: record.decision,
    message: record.message ?? null,
    decided_at: record.decided_at ?? null,
    decided_by_user_id: record.decided_by_user_id ?? null,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortKeys(item)]),
  );
}
