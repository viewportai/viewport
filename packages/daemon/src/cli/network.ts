import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export type TlsVerifyMode = 'auto' | '0' | '1';

export interface TransportFetchOptions extends RequestInit {
  timeoutMs?: number;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
}

type HttpsCheckServerIdentity = (hostname: string, cert: tls.PeerCertificate) => Error | undefined;

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.test')
  );
}

function normalizeFingerprint(input: string): string {
  return input.replace(/:/g, '').trim().toLowerCase();
}

function normalizePins(pins: string[] | undefined): string[] {
  if (!pins || pins.length === 0) return [];
  return pins
    .map((pin) => normalizeFingerprint(pin))
    .filter((pin): pin is string => pin.length > 0);
}

function resolveHttpsTrustOptions(
  parsedUrl: URL,
  options: TransportFetchOptions,
): {
  rejectUnauthorized?: boolean;
  ca?: Buffer;
  checkServerIdentity?: HttpsCheckServerIdentity;
} {
  if (parsedUrl.protocol !== 'https:') {
    return {};
  }

  const normalizedPins = normalizePins(options.tlsPins);
  const localHost = isLocalHostname(parsedUrl.hostname);
  let rejectUnauthorized: boolean;

  if (options.tlsVerify === '1') {
    rejectUnauthorized = true;
  } else if (options.tlsVerify === '0') {
    rejectUnauthorized = false;
  } else {
    rejectUnauthorized = !(localHost && !options.caCertPath && normalizedPins.length === 0);
  }

  const result: {
    rejectUnauthorized?: boolean;
    ca?: Buffer;
    checkServerIdentity?: HttpsCheckServerIdentity;
  } = { rejectUnauthorized };

  if (options.caCertPath) {
    result.ca = fs.readFileSync(options.caCertPath);
  }

  if (normalizedPins.length > 0) {
    result.checkServerIdentity = (hostname, cert) => {
      const defaultError = tls.checkServerIdentity(hostname, cert);
      if (defaultError) return defaultError;

      const actual = normalizeFingerprint(cert.fingerprint256 ?? '');
      if (!actual || !normalizedPins.includes(actual)) {
        return new Error('TLS pin mismatch');
      }
      return undefined;
    };
  }

  return result;
}

function isBodyValue(body: unknown): body is string | Buffer | Uint8Array {
  return typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array;
}

function shouldUseNativeFetch(parsedUrl: URL, options: TransportFetchOptions): boolean {
  if (typeof globalThis.fetch !== 'function') {
    return false;
  }

  if (options.caCertPath) {
    return false;
  }

  if (normalizePins(options.tlsPins).length > 0) {
    return false;
  }

  if (parsedUrl.protocol === 'http:') {
    return true;
  }

  if (parsedUrl.protocol !== 'https:') {
    return false;
  }

  if (options.tlsVerify === '0') {
    return false;
  }

  if (!options.tlsVerify || options.tlsVerify === 'auto') {
    return !isLocalHostname(parsedUrl.hostname);
  }

  return true;
}

export async function transportFetch(
  url: string,
  options: TransportFetchOptions = {},
): Promise<Response> {
  const parsedUrl = new URL(url);
  if (shouldUseNativeFetch(parsedUrl, options)) {
    const {
      timeoutMs: _timeoutMs,
      tlsVerify: _tlsVerify,
      caCertPath: _caCertPath,
      tlsPins: _tlsPins,
      ...nativeOptions
    } = options;
    return globalThis.fetch(url, nativeOptions);
  }

  const headers = new Headers(options.headers ?? {});
  const timeoutMs = options.timeoutMs ?? 3_000;
  const requestModule = parsedUrl.protocol === 'https:' ? https : http;
  const tlsOptions = resolveHttpsTrustOptions(parsedUrl, options);

  return await new Promise<Response>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('Aborted'));
      return;
    }

    const cleanupAbortListener = () => {
      options.signal?.removeEventListener('abort', abortListener);
    };

    const req = requestModule.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: options.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        ...tlsOptions,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          cleanupAbortListener();
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              responseHeaders.set(name, value.join(', '));
            } else if (typeof value === 'string') {
              responseHeaders.set(name, value);
            }
          }
          const responseBody =
            body.length === 0 || [204, 205, 304].includes(res.statusCode ?? 0) ? null : body;
          resolve(
            new Response(responseBody, {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? 'Unknown',
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout'));
    });

    req.once('error', (error) => {
      cleanupAbortListener();
      reject(error);
    });

    const abortListener = () => {
      req.destroy(
        options.signal?.reason instanceof Error ? options.signal.reason : new Error('Aborted'),
      );
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });

    if (isBodyValue(options.body)) {
      req.write(options.body);
    }

    req.end();
  });
}

export function parseTlsVerifyMode(raw: string | undefined): TlsVerifyMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return '1';
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return '0';
  }
  throw new Error(`Invalid TLS verify value: ${raw}. Expected auto|0|1.`);
}

export function parseCsvList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}
