import { describe, expect, it, vi, afterEach } from 'vitest';
import tls from 'node:tls';
import { resolveRelayTlsOptions } from '../../src/relay/bridge-network.js';

describe('relay bridge network tls options', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not attach pin verifier when no pins are configured', () => {
    const opts = resolveRelayTlsOptions('wss://relay.example.test/ws', '1');
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.checkServerIdentity).toBeUndefined();
  });

  it('enforces certificate fingerprint pin match when pins are configured', () => {
    vi.spyOn(tls, 'checkServerIdentity').mockReturnValue(undefined);
    const opts = resolveRelayTlsOptions('wss://relay.example.test/ws', '1', undefined, [
      'AA:BB:CC',
      '11:22:33',
    ]);
    expect(typeof opts.checkServerIdentity).toBe('function');

    const cert = { fingerprint256: 'aa:bb:cc' } as tls.DetailedPeerCertificate;
    const mismatch = { fingerprint256: 'ff:ee:dd' } as tls.DetailedPeerCertificate;

    expect(opts.checkServerIdentity?.('relay.example.test', cert)).toBe(true);
    expect(opts.checkServerIdentity?.('relay.example.test', mismatch)).toBe(false);
  });
});
