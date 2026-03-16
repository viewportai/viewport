import fs from 'node:fs';
import tls from 'node:tls';
import type { WebSocket as WsType } from 'ws';
import { DAEMON_CONNECT_TIMEOUT_MS, RELAY_CONNECT_TIMEOUT_MS } from './bridge-constants.js';
import { BridgeError } from './bridge-errors.js';

type RelayWs = WsType;
type WsCheckServerIdentity = (servername: string, cert: unknown) => boolean;

export function wsOpen(ws: RelayWs): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(
      () => {
        cleanup();
        reject(new BridgeError('WEBSOCKET_CONNECT_TIMEOUT', 'websocket connect timeout'));
      },
      ws.url.startsWith('ws://127.0.0.1') ? DAEMON_CONNECT_TIMEOUT_MS : RELAY_CONNECT_TIMEOUT_MS,
    );

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('open', onOpen);
      ws.off('error', onError);
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

export function resolveRelayTlsOptions(
  relayUrl: string,
  mode: 'auto' | '0' | '1',
  caCertPath?: string,
  relayTlsPins?: string[],
): { rejectUnauthorized?: boolean; ca?: Buffer; checkServerIdentity?: WsCheckServerIdentity } {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return {};
  }
  if (parsed.protocol !== 'wss:') return {};

  let rejectUnauthorized: boolean;
  if (mode === '1') {
    rejectUnauthorized = true;
  } else if (mode === '0') {
    rejectUnauthorized = false;
  } else {
    rejectUnauthorized = !(parsed.hostname.endsWith('.test') || parsed.hostname === 'localhost');
  }

  const result: {
    rejectUnauthorized?: boolean;
    ca?: Buffer;
    checkServerIdentity?: WsCheckServerIdentity;
  } = { rejectUnauthorized };
  if (caCertPath) {
    result.ca = fs.readFileSync(caCertPath);
  }

  const normalizedPins = normalizePins(relayTlsPins);
  if (normalizedPins.length > 0) {
    result.checkServerIdentity = (hostname: string, cert: unknown) => {
      const defaultError = tls.checkServerIdentity(
        hostname,
        cert as unknown as tls.PeerCertificate,
      );
      if (defaultError) return false;
      const fingerprint =
        cert && typeof cert === 'object' && 'fingerprint256' in cert
          ? String((cert as { fingerprint256?: unknown }).fingerprint256 ?? '')
          : '';
      const actual = normalizeFingerprint(fingerprint);
      if (!actual || !normalizedPins.includes(actual)) {
        return false;
      }
      return true;
    };
  }
  return result;
}

function normalizePins(pins: string[] | undefined): string[] {
  if (!pins || pins.length === 0) return [];
  return pins
    .map((pin) => normalizeFingerprint(pin))
    .filter((pin): pin is string => pin.length > 0);
}

function normalizeFingerprint(input: string): string {
  return input.replace(/:/g, '').trim().toLowerCase();
}

export function closeQuietly(ws: RelayWs | null | undefined): void {
  if (!ws) return;
  try {
    ws.close();
  } catch {
    // ignore
  }
}
