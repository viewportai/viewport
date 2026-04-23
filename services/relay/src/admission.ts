import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';
import type { RelayConfig } from './config.js';
import { resolveServerTlsRejectUnauthorized } from './config.js';
import type { AdmissionResult, RelayRole } from './types.js';

const tlsFileCache = new Map<string, { mtimeMs: number; content: Buffer }>();

interface ValidationResponseBody {
  ok?: boolean;
  reason?: string;
  error?: string;
  claims?: Record<string, unknown>;
}

interface ValidationRequestBody {
  relayToken: string;
  role: RelayRole;
  workspaceId: string;
}

const AdmissionClaimsSchema = z
  .object({
    clientId: z.string().min(1).max(128).optional(),
    userId: z.string().min(1).max(128).optional(),
    installId: z.string().min(1).max(128).optional(),
    role: z.enum(['workspace-daemon', 'client']).optional(),
    workspaceId: z.string().min(1).max(128).optional(),
    scope: z.enum(['runtime', 'pairing']).optional(),
    e2eeProfile: z.enum(['noise-ik', 'noise-ikpsk2']).optional(),
    policyMode: z.string().min(1).max(128).optional(),
    daemonPublicKey: z.string().min(1).max(512).nullable().optional(),
    pairingSecret: z.string().min(1).max(1024).nullable().optional(),
    relayWsBaseUrl: z.string().min(1).max(512).nullable().optional(),
    iss: z.string().min(1).max(255).optional(),
    aud: z.union([z.string().min(1).max(255), z.array(z.string().min(1).max(255))]).optional(),
    iat: z.number().int().optional(),
    exp: z.number().int().optional(),
    nbf: z.number().int().optional(),
    ver: z.number().int().optional(),
    jti: z.string().min(1).max(255).optional(),
    daemonIssueGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();

interface TlsOptions {
  rejectUnauthorized: boolean;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
}

function readTlsFileCached(filePath: string): Buffer {
  const stat = fs.statSync(filePath);
  const cached = tlsFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }
  const content = fs.readFileSync(filePath);
  tlsFileCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
  return content;
}

function postJson(
  url: URL,
  body: ValidationRequestBody,
  headers: Record<string, string>,
  tls: TlsOptions,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ status: number; json: ValidationResponseBody | null }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString(),
          ...headers,
        },
        rejectUnauthorized: isHttps ? tls.rejectUnauthorized : undefined,
        ca: isHttps ? tls.ca : undefined,
        cert: isHttps ? tls.cert : undefined,
        key: isHttps ? tls.key : undefined,
        passphrase: isHttps ? tls.passphrase : undefined,
      },
      (res) => {
        let raw = '';
        let totalBytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          totalBytes += Buffer.byteLength(chunk, 'utf8');
          if (totalBytes > maxResponseBytes) {
            req.destroy(new Error('admission response too large'));
            return;
          }
          raw += chunk;
        });
        res.on('end', () => {
          let json: ValidationResponseBody | null = null;
          try {
            json = JSON.parse(raw) as ValidationResponseBody;
          } catch {
            // keep null
          }
          resolve({
            status: res.statusCode ?? 500,
            json,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`admission request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function validateAdmission(
  config: RelayConfig,
  payload: { token: string; role: RelayRole; workspaceId: string },
): Promise<AdmissionResult> {
  const validateUrl = new URL('/api/runtime/internal/relay/validate', config.serverUrl);
  const rejectUnauthorized = resolveServerTlsRejectUnauthorized(
    validateUrl.toString(),
    config.serverTlsVerify,
  );
  const ca =
    config.serverCaCertPath && validateUrl.protocol === 'https:'
      ? readTlsFileCached(config.serverCaCertPath)
      : undefined;
  const cert =
    config.serverMtlsEnabled && validateUrl.protocol === 'https:'
      ? readTlsFileCached(config.serverClientCertPath)
      : undefined;
  const key =
    config.serverMtlsEnabled && validateUrl.protocol === 'https:'
      ? readTlsFileCached(config.serverClientKeyPath)
      : undefined;

  let status = 500;
  let json: ValidationResponseBody | null = null;
  try {
    const res = await postJson(
      validateUrl,
      {
        relayToken: payload.token,
        role: payload.role,
        workspaceId: payload.workspaceId,
      },
      config.relayInternalKey
        ? {
            'x-relay-internal-key': config.relayInternalKey,
          }
        : {},
      {
        rejectUnauthorized,
        ca,
        cert,
        key,
        passphrase: config.serverClientKeyPassphrase,
      },
      config.admissionTimeoutMs,
      config.admissionMaxResponseBytes,
    );
    status = res.status;
    json = res.json;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes('response too large')
    ) {
      return {
        ok: false,
        status: 502,
        reason: 'ADMISSION_RESPONSE_TOO_LARGE',
      };
    }
    return {
      ok: false,
      status: 504,
      reason: error instanceof Error ? error.message : 'ADMISSION_TIMEOUT',
    };
  }

  if (!json) {
    return { ok: false, status, reason: 'INVALID_JSON' };
  }

  const admissionOk = status >= 200 && status < 300 && json.ok === true;
  if (!admissionOk) {
    return {
      ok: false,
      status,
      reason: json.reason || json.error || 'VALIDATION_FAILED',
    };
  }

  const claimsParsed = AdmissionClaimsSchema.safeParse(json.claims);
  if (!claimsParsed.success) {
    return { ok: false, status, reason: 'INVALID_CLAIMS' };
  }

  return {
    ok: true,
    status,
    reason: json.reason || json.error || 'VALIDATION_FAILED',
    claims: claimsParsed.data,
  };
}
