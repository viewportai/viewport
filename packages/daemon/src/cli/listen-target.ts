import path from 'node:path';

export type DaemonListenTarget =
  | {
      type: 'tcp';
      host: string;
      port: number;
      listen: string;
    }
  | {
      type: 'socket';
      path: string;
      listen: string;
    };

const MIN_PORT = 1;
const MAX_PORT = 65535;

function normalizeTcpHost(value: string): string {
  const host = value.trim();
  if (host.length === 0) {
    throw new Error('Listen host cannot be empty');
  }
  return host;
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(`Invalid listen port: ${value}`);
  }
  return parsed;
}

function parseBracketedHostPort(raw: string): { host: string; port: number } | null {
  if (!raw.startsWith('[')) return null;
  const close = raw.indexOf(']');
  if (close < 0) return null;
  const host = raw.slice(0, close + 1);
  const rest = raw.slice(close + 1);
  if (!rest.startsWith(':')) {
    throw new Error(`Invalid listen target: ${raw}`);
  }
  return {
    host,
    port: parsePort(rest.slice(1)),
  };
}

function isLikelySocketPath(raw: string): boolean {
  return (
    raw.startsWith('/') ||
    raw.startsWith('./') ||
    raw.startsWith('../') ||
    raw.endsWith('.sock') ||
    raw.startsWith('unix://')
  );
}

export function parseListenTarget(rawValue: string, defaultHost = '127.0.0.1'): DaemonListenTarget {
  const raw = rawValue.trim();
  if (raw.length === 0) {
    throw new Error('Listen target is required');
  }

  if (raw.startsWith('unix://')) {
    const socket = raw.slice('unix://'.length);
    if (!socket) {
      throw new Error('Invalid unix socket listen target');
    }
    return {
      type: 'socket',
      path: path.resolve(socket),
      listen: `unix://${path.resolve(socket)}`,
    };
  }

  if (isLikelySocketPath(raw)) {
    return {
      type: 'socket',
      path: path.resolve(raw),
      listen: `unix://${path.resolve(raw)}`,
    };
  }

  if (/^\d+$/.test(raw)) {
    const port = parsePort(raw);
    const host = normalizeTcpHost(defaultHost);
    return {
      type: 'tcp',
      host,
      port,
      listen: `${host}:${port}`,
    };
  }

  const bracketed = parseBracketedHostPort(raw);
  if (bracketed) {
    return {
      type: 'tcp',
      host: normalizeTcpHost(bracketed.host),
      port: bracketed.port,
      listen: `${normalizeTcpHost(bracketed.host)}:${bracketed.port}`,
    };
  }

  const idx = raw.lastIndexOf(':');
  if (idx <= 0 || idx >= raw.length - 1) {
    throw new Error(`Invalid listen target: ${raw}`);
  }

  const host = normalizeTcpHost(raw.slice(0, idx));
  const port = parsePort(raw.slice(idx + 1));
  return {
    type: 'tcp',
    host,
    port,
    listen: `${host}:${port}`,
  };
}

export function formatListenTarget(target: DaemonListenTarget): string {
  if (target.type === 'socket') {
    return `unix://${target.path}`;
  }
  return `${target.host}:${target.port}`;
}
