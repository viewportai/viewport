import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import { stableJson } from '../context/local-edge-crypto.js';
import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import type { DaemonEvents } from '../core/events.js';

export const TRUSTED_EDGE_PLAN_BODY_SCHEMA = 'viewport.plan_body_encrypted/v1';
const TRUSTED_EDGE_PLAN_KEY_STORE_SCHEMA = 'viewport.trusted_edge_plan_keys/v1';
const PLAN_BODY_ALGORITHM = 'AES-GCM-256';

type PlanProposedEvent = DaemonEvents['hook:plan-proposed'];

export interface TrustedEdgePlanEnvelope {
  schema: typeof TRUSTED_EDGE_PLAN_BODY_SCHEMA;
  algorithm: typeof PLAN_BODY_ALGORITHM;
  key_ref: string;
  ciphertext: string;
  iv: string;
  tag: string;
  digest: string;
  aad: Record<string, unknown>;
}

export interface TrustedEdgePlanFeedbackEnvelope {
  schema: 'viewport.plan_feedback_field_encrypted/v1';
  algorithm: typeof PLAN_BODY_ALGORITHM;
  key_ref: string;
  ciphertext: string;
  iv: string;
  tag: string;
  digest: string;
  aad: Record<string, unknown>;
}

export interface TrustedEdgePlanRecord {
  workspaceId: string;
  planId?: string;
  sourceRef: string;
  keyRef: string;
  rawKey: string;
  bodySha256: string;
  createdAt: string;
  updatedAt: string;
}

interface TrustedEdgePlanKeyStore {
  schema: typeof TRUSTED_EDGE_PLAN_KEY_STORE_SCHEMA;
  records: TrustedEdgePlanRecord[];
}

export interface TrustedEdgePlanSyncTarget {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
}

export async function saveTrustedEdgePlanDraft(options: {
  event: PlanProposedEvent;
  target: TrustedEdgePlanSyncTarget;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ planId: string; sourceRef: string; envelope: TrustedEdgePlanEnvelope }> {
  const sourceRef = options.event.sourceRef ?? `agent-hook:${options.event.sessionId}`;
  const encrypted = await encryptTrustedEdgePlanBody({
    workspaceId: options.target.workspaceId,
    sourceRef,
    sessionId: options.event.sessionId,
    body: options.event.body,
    source: options.event.source ?? options.event.adapter ?? null,
  });
  await upsertTrustedEdgePlanKey(
    {
      workspaceId: options.target.workspaceId,
      sourceRef,
      keyRef: encrypted.envelope.key_ref,
      rawKey: encrypted.rawKey.toString('base64'),
      bodySha256: encrypted.envelope.digest,
    },
    options.home,
  );

  const payload = await postJson(
    options.fetchImpl ?? transportFetch,
    `${options.target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(options.target.workspaceId)}/agent-hooks/plans`,
    {
      credential: options.target.credential,
      hook_event_name: 'PlanProposed',
      schema: 'viewport.plan_proposal/v1',
      session_id: options.event.sessionId,
      cwd: options.event.cwd ?? null,
      title: options.event.title?.trim() || 'Agent plan',
      summary: options.event.summary?.trim() || null,
      body_encryption: encrypted.envelope,
      source: options.event.source ?? options.event.adapter ?? null,
      source_ref: sourceRef,
      payload: {
        ...(options.event.metadata ?? {}),
        privacy: 'trusted-edge',
        encrypted_by: 'vpd',
      },
    },
    {
      tlsVerify: options.target.tlsVerify,
      caCertPath: options.target.caCertPath,
      tlsPins: options.target.tlsPins,
    },
  );

  const plan = objectField(payload, 'data');
  const planId = stringField(plan, 'id');
  await upsertTrustedEdgePlanKey(
    {
      workspaceId: options.target.workspaceId,
      planId,
      sourceRef,
      keyRef: encrypted.envelope.key_ref,
      rawKey: encrypted.rawKey.toString('base64'),
      bodySha256: encrypted.envelope.digest,
    },
    options.home,
  );

  return { planId, sourceRef, envelope: encrypted.envelope };
}

export async function decryptTrustedEdgePlanBody(options: {
  workspaceId: string;
  planId?: string;
  sourceRef?: string;
  envelope: TrustedEdgePlanEnvelope;
  home?: string;
}): Promise<{ body: string; bodySha256: string; keyRef: string }> {
  const record = await findTrustedEdgePlanKey(
    {
      workspaceId: options.workspaceId,
      planId: options.planId,
      sourceRef: options.sourceRef,
      keyRef: options.envelope.key_ref,
    },
    options.home,
  );
  if (!record) {
    throw new Error('Trusted edge does not have the key for this plan.');
  }

  const body = decryptEnvelope(options.envelope, Buffer.from(record.rawKey, 'base64'));
  const digest = digestText(body);
  if (
    record.bodySha256 &&
    record.bodySha256 !== digest &&
    record.bodySha256 !== options.envelope.digest
  ) {
    throw new Error('Trusted edge plan key does not match this encrypted body.');
  }

  return { body, bodySha256: digest, keyRef: record.keyRef };
}

export async function encryptTrustedEdgePlanFeedbackField(options: {
  workspaceId: string;
  planId?: string;
  sourceRef?: string;
  envelope: TrustedEdgePlanEnvelope;
  text: string;
  aad?: Record<string, unknown>;
  home?: string;
}): Promise<TrustedEdgePlanFeedbackEnvelope> {
  const record = await findTrustedEdgePlanKey(
    {
      workspaceId: options.workspaceId,
      planId: options.planId,
      sourceRef: options.sourceRef,
      keyRef: options.envelope.key_ref,
    },
    options.home,
  );
  if (!record) {
    throw new Error('Trusted edge does not have the key for this plan.');
  }
  const rawKey = Buffer.from(record.rawKey, 'base64');
  const aad = options.aad ?? {};
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
  cipher.setAAD(Buffer.from(stableJson(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(options.text, 'utf8'), cipher.final()]);

  return {
    schema: 'viewport.plan_feedback_field_encrypted/v1',
    algorithm: PLAN_BODY_ALGORITHM,
    key_ref: options.envelope.key_ref,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    digest: digestText(options.text),
    aad,
  };
}

async function encryptTrustedEdgePlanBody(input: {
  workspaceId: string;
  sourceRef: string;
  sessionId: string;
  body: string;
  source: string | null;
}): Promise<{ envelope: TrustedEdgePlanEnvelope; rawKey: Buffer }> {
  const rawKey = crypto.randomBytes(32);
  const keyRef = `trusted-edge-plan-${crypto.randomUUID()}`;
  const aad = {
    purpose: 'trusted-edge-plan-body',
    workspace_id: input.workspaceId,
    source_ref: input.sourceRef,
    session_id: input.sessionId,
    source: input.source,
    created_at: new Date().toISOString(),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
  cipher.setAAD(Buffer.from(stableJson(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(input.body, 'utf8'), cipher.final()]);

  return {
    rawKey,
    envelope: {
      schema: TRUSTED_EDGE_PLAN_BODY_SCHEMA,
      algorithm: PLAN_BODY_ALGORITHM,
      key_ref: keyRef,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      digest: digestText(input.body),
      aad,
    },
  };
}

function decryptEnvelope(envelope: TrustedEdgePlanEnvelope, rawKey: Buffer): string {
  if (envelope.schema !== TRUSTED_EDGE_PLAN_BODY_SCHEMA) {
    throw new Error(`Unsupported plan body schema: ${envelope.schema}`);
  }
  if (envelope.algorithm !== PLAN_BODY_ALGORITHM) {
    throw new Error(`Unsupported plan body algorithm: ${envelope.algorithm}`);
  }
  if (!envelope.tag) {
    throw new Error('Trusted-edge plan envelope is missing an authentication tag.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    rawKey,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(stableJson(envelope.aad ?? {}), 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function upsertTrustedEdgePlanKey(
  input: Omit<TrustedEdgePlanRecord, 'createdAt' | 'updatedAt'>,
  home = configDir(),
): Promise<void> {
  const store = await readTrustedEdgePlanKeyStore(home);
  const now = new Date().toISOString();
  const existing = store.records.find(
    (record) =>
      record.workspaceId === input.workspaceId &&
      record.keyRef === input.keyRef &&
      ((input.planId && record.planId === input.planId) ||
        (!input.planId && record.sourceRef === input.sourceRef)),
  );
  if (existing) {
    Object.assign(existing, input, { updatedAt: now });
  } else {
    store.records.push({ ...input, createdAt: now, updatedAt: now });
  }
  await writeTrustedEdgePlanKeyStore(store, home);
}

async function findTrustedEdgePlanKey(
  input: { workspaceId: string; planId?: string; sourceRef?: string; keyRef: string },
  home = configDir(),
): Promise<TrustedEdgePlanRecord | null> {
  const store = await readTrustedEdgePlanKeyStore(home);
  return (
    store.records.find(
      (record) =>
        record.workspaceId === input.workspaceId &&
        record.keyRef === input.keyRef &&
        ((input.planId && record.planId === input.planId) ||
          (input.sourceRef && record.sourceRef === input.sourceRef)),
    ) ?? null
  );
}

async function readTrustedEdgePlanKeyStore(home = configDir()): Promise<TrustedEdgePlanKeyStore> {
  try {
    const raw = await fs.readFile(trustedEdgePlanKeyStorePath(home), 'utf8');
    const parsed = JSON.parse(raw) as TrustedEdgePlanKeyStore;
    if (parsed.schema !== TRUSTED_EDGE_PLAN_KEY_STORE_SCHEMA || !Array.isArray(parsed.records)) {
      throw new Error('Invalid trusted-edge plan key store.');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: TRUSTED_EDGE_PLAN_KEY_STORE_SCHEMA, records: [] };
    }
    throw error;
  }
}

async function writeTrustedEdgePlanKeyStore(
  store: TrustedEdgePlanKeyStore,
  home = configDir(),
): Promise<void> {
  const filePath = trustedEdgePlanKeyStorePath(home);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

function trustedEdgePlanKeyStorePath(home = configDir()): string {
  return path.join(home, 'plans', 'trusted-edge-keys.json');
}

async function postJson(
  fetchImpl: typeof transportFetch,
  url: string,
  body: Record<string, unknown>,
  transportOptions: {
    tlsVerify?: TlsVerifyMode;
    caCertPath?: string;
    tlsPins?: string[];
  } = {},
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 5_000,
    ...transportOptions,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const reason =
      payload && typeof payload === 'object' && 'reason' in payload
        ? String((payload as { reason?: unknown }).reason)
        : `${response.status} ${response.statusText}`;
    throw new Error(`Plan hook sync request failed: ${reason}`);
  }
  return payload;
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected response object while reading ${field}`);
  }
  const child = (value as Record<string, unknown>)[field];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`Plan hook sync response did not include ${field}`);
  }
  return child as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const child = value[field];
  if (typeof child !== 'string' || child.trim().length === 0) {
    throw new Error(`Plan hook sync response did not include ${field}`);
  }
  return child;
}
