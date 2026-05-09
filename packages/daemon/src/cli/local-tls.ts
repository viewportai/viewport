import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { configDir, configFilePath, resourceOverrideConfigFilePath } from '../core/config.js';

export interface LocalTlsState {
  enabled: boolean;
  host: string;
  certDir?: string;
  certPath?: string;
  keyPath?: string;
}

function readConfigHosts(filePath: string | null): string[] {
  if (!filePath) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      daemon?: {
        server?: { url?: unknown; appUrl?: unknown };
        relay?: { endpoint?: unknown; serverUrl?: unknown };
      };
    };
    const values = [
      parsed.daemon?.server?.appUrl,
      parsed.daemon?.server?.url,
      parsed.daemon?.relay?.endpoint,
      parsed.daemon?.relay?.serverUrl,
    ];
    const hosts: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      try {
        const host = new URL(value).hostname;
        if (!host) continue;
        hosts.push(host);
        if (!host.startsWith('app.')) hosts.push(`app.${host}`);
      } catch {
        // Ignore malformed local config values. Runtime config validation reports
        // invalid daemon URLs elsewhere.
      }
    }
    return hosts;
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function resolveLocalTlsState(env: NodeJS.ProcessEnv = process.env): LocalTlsState {
  const tlsEnv = (env['VIEWPORT_TLS'] ?? 'auto').toLowerCase();
  const explicitHost = env['VIEWPORT_TLS_HOST']?.trim();
  const fallbackHost = explicitHost || 'localhost';

  if (tlsEnv === '0' || tlsEnv === 'false' || tlsEnv === 'off') {
    return { enabled: false, host: '127.0.0.1' };
  }

  const globalCertDir = path.join(configDir(), 'certs');
  const resourceOverrideConfigPath = resourceOverrideConfigFilePath(env);
  const projectCertDir = resourceOverrideConfigPath
    ? path.join(path.dirname(resourceOverrideConfigPath), 'certs')
    : null;
  const certDirs = env['VIEWPORT_TLS_CERT_DIR']?.trim()
    ? [env['VIEWPORT_TLS_CERT_DIR'].trim()]
    : [projectCertDir, globalCertDir].filter((value): value is string => !!value);
  const hosts = explicitHost
    ? [explicitHost]
    : unique([
        'localhost',
        ...readConfigHosts(resourceOverrideConfigPath),
        ...readConfigHosts(configFilePath()),
      ]);

  for (const host of hosts) {
    for (const certDir of certDirs) {
      const certPath = env['VIEWPORT_TLS_CERT'] ?? path.join(certDir, `${host}.crt`);
      const keyPath = env['VIEWPORT_TLS_KEY'] ?? path.join(certDir, `${host}.key`);
      if (!existsSync(certPath) || !existsSync(keyPath)) continue;
      return { enabled: true, host, certDir, certPath, keyPath };
    }
  }

  if (tlsEnv === '1' || tlsEnv === 'true' || tlsEnv === 'on') {
    const certDir = env['VIEWPORT_TLS_CERT_DIR']?.trim() || globalCertDir;
    return {
      enabled: true,
      host: fallbackHost,
      certDir,
      certPath: env['VIEWPORT_TLS_CERT'] ?? path.join(certDir, `${fallbackHost}.crt`),
      keyPath: env['VIEWPORT_TLS_KEY'] ?? path.join(certDir, `${fallbackHost}.key`),
    };
  }

  return { enabled: false, host: '127.0.0.1' };
}
