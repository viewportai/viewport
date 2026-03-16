import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import type { RelayConfig } from './config.js';
import { resolveServerTlsRejectUnauthorized } from './config.js';

export interface JsonResult<TJson> {
  status: number;
  json: TJson | null;
}

export interface InternalTlsOptions {
  rejectUnauthorized: boolean;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
}

export function resolveInternalApiTlsRejectUnauthorized(config: RelayConfig): boolean {
  return resolveServerTlsRejectUnauthorized(config.serverUrl, config.serverTlsVerify);
}

export function resolveInternalApiTlsOptions(config: RelayConfig): InternalTlsOptions {
  const options: InternalTlsOptions = {
    rejectUnauthorized: resolveInternalApiTlsRejectUnauthorized(config),
  };
  if (config.serverCaCertPath) {
    options.ca = fs.readFileSync(config.serverCaCertPath);
  }
  if (config.serverMtlsEnabled) {
    options.cert = fs.readFileSync(config.serverClientCertPath);
    options.key = fs.readFileSync(config.serverClientKeyPath);
    if (config.serverClientKeyPassphrase) {
      options.passphrase = config.serverClientKeyPassphrase;
    }
  }
  return options;
}

export async function postInternalJson<TBody extends Record<string, unknown>, TJson>(
  url: URL,
  body: TBody,
  headers: Record<string, string>,
  tls: InternalTlsOptions,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<JsonResult<TJson>> {
  return await new Promise((resolve, reject) => {
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
            req.destroy(new Error('internal api response too large'));
            return;
          }
          raw += chunk;
        });
        res.on('end', () => {
          let json: TJson | null = null;
          try {
            json = JSON.parse(raw) as TJson;
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
      req.destroy(new Error(`internal API request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
