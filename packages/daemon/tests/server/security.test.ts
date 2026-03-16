import { describe, expect, it } from 'vitest';
import {
  buildSecurityProfile,
  isHostAllowed,
  isOriginAllowed,
  isPathWithin,
  parseAllowedHosts,
} from '../../src/server/security.js';

describe('security profile helpers', () => {
  it('requires loopback host for local profile', () => {
    expect(() =>
      buildSecurityProfile({
        profile: 'local',
        host: '0.0.0.0',
        explicitAuthFlag: false,
      }),
    ).toThrow(/requires loopback host/i);
  });

  it('requires allowlist for lan and relay profiles', () => {
    expect(() =>
      buildSecurityProfile({
        profile: 'lan',
        host: '0.0.0.0',
        explicitAuthFlag: false,
      }),
    ).toThrow(/requires --allowed-hosts/i);

    expect(() =>
      buildSecurityProfile({
        profile: 'relay',
        host: '0.0.0.0',
        explicitAuthFlag: false,
      }),
    ).toThrow(/requires --allowed-hosts/i);
  });

  it('parses allowlists and supports explicit wildcard', () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('')).toEqual([]);
    expect(parseAllowedHosts('true')).toBe(true);
    expect(parseAllowedHosts('example.test, .internal.test')).toEqual([
      'example.test',
      '.internal.test',
    ]);
  });

  it('enforces host allowlist and subdomain rules', () => {
    const profile = {
      profile: 'lan' as const,
      host: '0.0.0.0',
      allowedHosts: ['example.test', '.internal.test'],
      requireAuth: true,
    };

    expect(isHostAllowed('example.test:7070', profile)).toBe(true);
    expect(isHostAllowed('api.internal.test', profile)).toBe(true);
    expect(isHostAllowed('localhost:7070', profile)).toBe(true);
    expect(isHostAllowed('evil.test', profile)).toBe(false);
  });

  it('rejects over-broad short suffix rules', () => {
    const profile = {
      profile: 'lan' as const,
      host: '0.0.0.0',
      allowedHosts: ['.com', '.example.com'],
      requireAuth: true,
    };

    expect(isHostAllowed('api.evil.com', profile)).toBe(false);
    expect(isHostAllowed('example.com', profile)).toBe(true);
    expect(isHostAllowed('api.example.com', profile)).toBe(true);
  });

  it('enforces origin allowlist with loopback allowance', () => {
    const profile = {
      profile: 'lan' as const,
      host: '0.0.0.0',
      allowedHosts: ['example.test'],
      requireAuth: true,
    };

    expect(isOriginAllowed(undefined, profile)).toBe(true);
    expect(isOriginAllowed('http://example.test', profile)).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', profile)).toBe(true);
    expect(isOriginAllowed('https://evil.test', profile)).toBe(false);
    expect(isOriginAllowed('this-is-not-a-url', profile)).toBe(false);
  });

  it('blocks sibling-prefix path traversal attempts', () => {
    expect(isPathWithin('/tmp/base', '/tmp/base/file.txt')).toBe(true);
    expect(isPathWithin('/tmp/base', '/tmp/base/child/nested.txt')).toBe(true);
    expect(isPathWithin('/tmp/base', '/tmp/base2/secret.txt')).toBe(false);
    expect(isPathWithin('/tmp/base', '/tmp/other/place.txt')).toBe(false);
  });
});
