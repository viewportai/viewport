import fs from 'node:fs/promises';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { resolveWorkspaceSyncTarget } from './context-sync-target.js';
import { transportFetch } from './network.js';

interface SignalFeatures {
  repository?: string;
  changed_paths: string[];
  labels: string[];
  text_tokens: string[];
  embedding?: number[];
  embedding_model?: string;
}

interface SignalFeatureEnvelope {
  schema: 'viewport.cli.signal_features/v1';
  extraction: {
    source: 'tenant_side_signal_extractor';
    raw_message_content_used_locally: boolean;
    raw_message_content_posted: false;
    raw_message_content_stored_in_output: false;
    privacy_preserving_features_only: true;
    learned_state_expands_access: false;
    authorization_remains_separate: true;
  };
  signal_features: SignalFeatures;
}

export async function signal(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showSignalHelp();
    return;
  }

  if (subcommand === 'features') {
    await signalFeatures();
    return;
  }

  throw new Error(signalUsage());
}

function signalUsage(): string {
  return 'Usage: vpd signal features [--repo <org/repo>] [--changed-path <path>...] [--label <label>...] [--text <text>|--text-file <path>|--stdin] [--token <token>...] [--embedding <n,n,...> --embedding-model <name>] [--project] [--provider <name>] [--event-type <type>] [--workspace <id> --server-url <url> --credential <token>] [--json]';
}

function showSignalHelp(): void {
  console.log(signalUsage());
}

async function signalFeatures(): Promise<void> {
  const envelope = await extractSignalFeatures();

  if (hasFlag('project')) {
    const projected = await projectSignalFeatures(envelope);
    const output = {
      command: 'signal features',
      ok: true,
      projected: true,
      local: envelope,
      platform: projected,
    };
    if (isJsonMode()) {
      printJson(output);
      return;
    }
    console.log(`Projected signal features: ${projectedFeatureDigest(projected) ?? 'ok'}`);
    return;
  }

  if (isJsonMode()) {
    printJson({
      command: 'signal features',
      ok: true,
      projected: false,
      ...envelope,
    });
    return;
  }

  console.log('Signal features extracted locally.');
  console.log(`Repository:    ${envelope.signal_features.repository ?? '-'}`);
  console.log(`Changed paths: ${envelope.signal_features.changed_paths.join(', ') || '-'}`);
  console.log(`Labels:        ${envelope.signal_features.labels.join(', ') || '-'}`);
  console.log(`Text tokens:   ${envelope.signal_features.text_tokens.join(', ') || '-'}`);
  if (envelope.signal_features.embedding) {
    console.log(
      `Embedding:     ${envelope.signal_features.embedding.length} dims (${envelope.signal_features.embedding_model ?? 'unknown model'})`,
    );
  }
}

async function extractSignalFeatures(): Promise<SignalFeatureEnvelope> {
  const rawText = await rawTextInput();
  const textTokens = uniqueBounded(
    [...valuesForFlag('token'), ...tokens(rawText)],
    100,
    80,
    normalizeToken,
  );
  const changedPaths = uniqueBounded(
    [...valuesForFlag('changed-path'), ...valuesForFlag('file')],
    100,
    500,
    normalizePath,
  );
  const labels = uniqueBounded(valuesForFlag('label'), 50, 128, normalizeAtom);
  const embedding = parseEmbedding(getFlag('embedding'));
  const embeddingModel = normalizeEmbeddingModel(getFlag('embedding-model') ?? getFlag('model'));
  const repository = normalizeRepository(getFlag('repo') ?? getFlag('repository'));

  return {
    schema: 'viewport.cli.signal_features/v1',
    extraction: {
      source: 'tenant_side_signal_extractor',
      raw_message_content_used_locally: rawText.trim().length > 0,
      raw_message_content_posted: false,
      raw_message_content_stored_in_output: false,
      privacy_preserving_features_only: true,
      learned_state_expands_access: false,
      authorization_remains_separate: true,
    },
    signal_features: {
      ...(repository ? { repository } : {}),
      changed_paths: changedPaths,
      labels,
      text_tokens: textTokens,
      ...(embedding ? { embedding } : {}),
      ...(embeddingModel ? { embedding_model: embeddingModel } : {}),
    },
  };
}

async function projectSignalFeatures(envelope: SignalFeatureEnvelope): Promise<unknown> {
  const target = await resolveWorkspaceSyncTarget('signal features --project');
  const response = await transportFetch(
    `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(target.workspaceId)}/signal-features/project`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        credential: target.credential,
        target_workspace_id: target.workspaceId,
        provider: getFlag('provider') ?? null,
        event_type: getFlag('event-type') ?? null,
        signal_features: envelope.signal_features,
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    },
  );
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Failed to project signal features: HTTP ${response.status}`);
  }

  return payload;
}

async function rawTextInput(): Promise<string> {
  const explicitText = getFlag('text');
  if (typeof explicitText === 'string') {
    return explicitText;
  }

  const textFile = getFlag('text-file');
  if (typeof textFile === 'string' && textFile.trim() !== '') {
    return await fs.readFile(textFile, 'utf8');
  }

  if (hasFlag('stdin')) {
    return await readStdin();
  }

  return '';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function valuesForFlag(name: string): string[] {
  const values: string[] = [];
  const args = getArgs();
  const flag = `--${name}`;
  const inlinePrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) {
      const next = args[index + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        values.push(next);
        index += 1;
      }
      continue;
    }
    if (typeof value === 'string' && value.startsWith(inlinePrefix)) {
      values.push(value.slice(inlinePrefix.length));
    }
  }
  return values;
}

function tokens(input: string): string[] {
  if (input.trim() === '') return [];
  return input
    .toLowerCase()
    .split(/[^a-z0-9_.\\/-]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && !STOP_WORDS.has(value));
}

function uniqueBounded(
  values: string[],
  limit: number,
  maxLength: number,
  normalize: (value: string) => string | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const normalized = normalize(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized.slice(0, maxLength));
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeRepository(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.\\/-]+/g, '')
    .replace(/^\/+|\/+$/g, '');
  return normalized || undefined;
}

function normalizePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/g, '');
  if (
    normalized === '' ||
    normalized.includes('..') ||
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/')
  ) {
    return null;
  }
  return normalized;
}

function normalizeAtom(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.\\/-]+/g, '');
  return normalized || null;
}

function normalizeToken(value: string): string | null {
  const normalized = normalizeAtom(value)?.replace(/^[._/-]+|[._/-]+$/g, '');
  if (!normalized || normalized.length < 3 || STOP_WORDS.has(normalized)) return null;
  return normalized;
}

function parseEmbedding(raw: string | undefined): number[] | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value));
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('--embedding must be a comma-separated numeric vector');
  }
  return values.map((value) => Math.round(value * 100000000) / 100000000);
}

function normalizeEmbeddingModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.\\/:@-]+/g, '');
  return normalized || undefined;
}

function projectedFeatureDigest(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = (payload as Record<string, unknown>)['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const digest = (data as Record<string, unknown>)['feature_digest'];
  return typeof digest === 'string' ? digest : null;
}

const STOP_WORDS = new Set([
  'and',
  'are',
  'but',
  'for',
  'from',
  'has',
  'have',
  'into',
  'not',
  'our',
  'that',
  'the',
  'this',
  'with',
  'you',
]);
