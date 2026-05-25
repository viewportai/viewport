/**
 * HTTP client helpers for talking to a running daemon instance.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { configDir } from '../core/config.js';
import { getFlag, getDaemonPort, hasFlag } from './args.js';
import { readDaemonRuntimeState } from './daemon-lifecycle.js';
import { parseListenTarget } from './listen-target.js';
import { parseCsvList, parseTlsVerifyMode, transportFetch } from './network.js';
import { resolveLocalTlsState } from './local-tls.js';

export interface DaemonDirectoryInfo {
  id: string;
  name: string;
  path: string;
  activeSessions: string[];
}

export type DaemonEndpoint =
  | {
      type: 'tcp';
      host: string;
      port: number;
      baseUrl: string;
      wsUrl: string;
    }
  | {
      type: 'socket';
      socketPath: string;
      baseUrl: string;
      wsUrl: string;
    };

export interface DaemonFetchOptions extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

let cachedAuthToken: string | null | undefined;

function resolveClientHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

async function readAuthToken(): Promise<string | null> {
  if (cachedAuthToken !== undefined) return cachedAuthToken;
  try {
    const tokenPath = path.join(configDir(), 'auth-token');
    const token = (await fs.readFile(tokenPath, 'utf-8')).trim();
    cachedAuthToken = token.length > 0 ? token : null;
  } catch {
    cachedAuthToken = null;
  }
  return cachedAuthToken;
}

function resolveTlsPreferenceFromStateOrEnv(
  state?: {
    tlsEnabled?: boolean;
    tlsHost?: string;
  } | null,
): { enabled: boolean; host: string } {
  if (typeof state?.tlsEnabled === 'boolean') {
    return {
      enabled: state.tlsEnabled,
      host: state.tlsHost?.trim() || process.env['VIEWPORT_TLS_HOST'] || 'localhost',
    };
  }
  const tls = resolveLocalTlsState();
  return { enabled: tls.enabled, host: tls.host };
}

function resolveEndpointFromFlags(): DaemonEndpoint {
  const tlsInfo = resolveTlsPreferenceFromStateOrEnv(null);
  const httpScheme = tlsInfo.enabled ? 'https' : 'http';
  const wsScheme = tlsInfo.enabled ? 'wss' : 'ws';

  const listenFlag = getFlag('listen');
  if (listenFlag) {
    const parsed = parseListenTarget(listenFlag);
    if (parsed.type === 'socket') {
      return {
        type: 'socket',
        socketPath: parsed.path,
        baseUrl: 'http://localhost',
        wsUrl: `ws+unix://${parsed.path}:/ws`,
      };
    }
    const host = tlsInfo.enabled ? tlsInfo.host : resolveClientHost(parsed.host);
    return {
      type: 'tcp',
      host,
      port: parsed.port,
      baseUrl: `${httpScheme}://${host}:${parsed.port}`,
      wsUrl: `${wsScheme}://${host}:${parsed.port}/ws`,
    };
  }

  const host = tlsInfo.enabled ? tlsInfo.host : resolveClientHost(getFlag('host') ?? '127.0.0.1');
  const port = getDaemonPort();
  return {
    type: 'tcp',
    host,
    port,
    baseUrl: `${httpScheme}://${host}:${port}`,
    wsUrl: `${wsScheme}://${host}:${port}/ws`,
  };
}

function hasExplicitDaemonEndpointFlag(): boolean {
  return hasFlag('listen') || hasFlag('host') || hasFlag('port');
}

export function daemonEndpointLabel(endpoint: DaemonEndpoint): string {
  if (endpoint.type === 'socket') {
    return `unix://${endpoint.socketPath}`;
  }

  return endpoint.baseUrl;
}

function resolveDaemonTransportOptions(endpoint: DaemonEndpoint): {
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
} {
  if (endpoint.type !== 'tcp' || !endpoint.baseUrl.startsWith('https://')) {
    return {};
  }

  return {
    tlsVerify:
      parseTlsVerifyMode(process.env['VPD_DAEMON_TLS_VERIFY']) ??
      parseTlsVerifyMode(process.env['VIEWPORT_DAEMON_TLS_VERIFY']) ??
      'auto',
    caCertPath:
      process.env['VPD_DAEMON_CA_CERT'] ??
      process.env['VIEWPORT_DAEMON_CA_CERT'] ??
      process.env['VIEWPORT_TLS_CERT'],
    tlsPins:
      parseCsvList(process.env['VPD_DAEMON_TLS_PINS']) ??
      parseCsvList(process.env['VIEWPORT_DAEMON_TLS_PINS']),
  };
}

export async function resolveDaemonEndpoint(): Promise<DaemonEndpoint> {
  if (hasExplicitDaemonEndpointFlag()) {
    return resolveEndpointFromFlags();
  }

  const state = await readDaemonRuntimeState();
  if (state) {
    const tlsInfo = resolveTlsPreferenceFromStateOrEnv(state);
    const httpScheme = tlsInfo.enabled ? 'https' : 'http';
    const wsScheme = tlsInfo.enabled ? 'wss' : 'ws';
    if (state.socketPath) {
      return {
        type: 'socket',
        socketPath: state.socketPath,
        baseUrl: 'http://localhost',
        wsUrl: `ws+unix://${state.socketPath}:/ws`,
      };
    }
    // When TLS is enabled, prefer the configured TLS hostname instead of the
    // bound listen host so local certs can terminate correctly.
    const host = tlsInfo.enabled ? tlsInfo.host : resolveClientHost(state.host);
    return {
      type: 'tcp',
      host,
      port: state.port,
      baseUrl: `${httpScheme}://${host}:${state.port}`,
      wsUrl: `${wsScheme}://${host}:${state.port}/ws`,
    };
  }

  return resolveEndpointFromFlags();
}

function isBodyText(body: unknown): body is string | Buffer {
  return typeof body === 'string' || Buffer.isBuffer(body);
}

async function fetchViaUnixSocket(
  endpoint: Extract<DaemonEndpoint, { type: 'socket' }>,
  urlPath: string,
  options: DaemonFetchOptions,
  token: string | null,
): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const body = options.body ?? null;

  return await new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: endpoint.socketPath,
        path: urlPath,
        method,
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              responseHeaders.set(name, value.join(', '));
            } else if (typeof value === 'string') {
              responseHeaders.set(name, value);
            }
          }
          resolve(
            new Response(buffer, {
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

    req.once('error', reject);

    if (isBodyText(body)) {
      req.write(body);
    }
    req.end();
  });
}

/** Try to reach the running daemon. Returns null if not reachable. */
export async function daemonFetch(
  urlPath: string,
  options: DaemonFetchOptions = {},
): Promise<Response | null> {
  try {
    const token = await readAuthToken();
    const endpoint = await resolveDaemonEndpoint();

    if (endpoint.type === 'socket') {
      return await fetchViaUnixSocket(endpoint, urlPath, options, token);
    }

    const headers = new Headers(options.headers ?? {});
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return await transportFetch(`${endpoint.baseUrl}${urlPath}`, {
      ...options,
      headers,
      ...resolveDaemonTransportOptions(endpoint),
    });
  } catch {
    return null;
  }
}

/** Check if the daemon is running. */
export async function isDaemonRunning(): Promise<boolean> {
  const res = await daemonFetch('/health');
  return res !== null && res.ok;
}
