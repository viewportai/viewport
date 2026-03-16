import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  LocalAuthProvider,
  NoopAuthProvider,
  extractBearerToken,
  extractTokenFromRequest,
} from '../../src/server/auth.js';

// ---------------------------------------------------------------------------
// LocalAuthProvider — uses a temp dir to avoid touching real ~/.viewport
// ---------------------------------------------------------------------------

describe('LocalAuthProvider', () => {
  let tmpDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-auth-test-'));
    originalHome = os.homedir();
    // Override HOME so configDir() returns our temp dir
    process.env['HOME'] = tmpDir;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('generates and persists a token on first init', async () => {
    const provider = new LocalAuthProvider();
    await provider.initialize();

    const token = provider.getDisplayToken();
    expect(token).toBeTruthy();
    expect(token!.length).toBe(64); // 32 bytes = 64 hex chars

    // Token file should exist
    const tokenPath = path.join(tmpDir, '.viewport', 'auth-token');
    const fileContent = await fs.readFile(tokenPath, 'utf-8');
    expect(fileContent.trim()).toBe(token);
  });

  it('loads an existing token on subsequent init', async () => {
    // Write a known token
    const knownToken = 'a'.repeat(64);
    const viewportDir = path.join(tmpDir, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });
    await fs.writeFile(path.join(viewportDir, 'auth-token'), knownToken + '\n');

    const provider = new LocalAuthProvider();
    await provider.initialize();

    expect(provider.getDisplayToken()).toBe(knownToken);
  });

  it('validate() returns true for correct token', async () => {
    const provider = new LocalAuthProvider();
    await provider.initialize();

    const token = provider.getDisplayToken()!;
    expect(await provider.validate(token)).toBe(true);
  });

  it('validate() returns false for wrong token', async () => {
    const provider = new LocalAuthProvider();
    await provider.initialize();

    expect(await provider.validate('wrong-token')).toBe(false);
  });

  it('validate() never compares a token buffer against itself on length mismatch', async () => {
    const provider = new LocalAuthProvider();
    await provider.initialize();

    const calls: Array<[NodeJS.ArrayBufferView, NodeJS.ArrayBufferView]> = [];
    const spy = vi
      .spyOn(crypto, 'timingSafeEqual')
      .mockImplementation((a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        calls.push([a, b]);
        return false;
      });

    try {
      expect(await provider.validate('x')).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
      for (const [left, right] of calls) {
        expect(left === right).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('validate() returns false before initialization', async () => {
    const provider = new LocalAuthProvider();
    // Not initialized — token is null
    expect(await provider.validate('anything')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NoopAuthProvider
// ---------------------------------------------------------------------------

describe('NoopAuthProvider', () => {
  it('always returns true from validate()', async () => {
    const provider = new NoopAuthProvider();
    expect(await provider.validate('anything')).toBe(true);
    expect(await provider.validate('')).toBe(true);
  });

  it('returns null from getDisplayToken()', () => {
    const provider = new NoopAuthProvider();
    expect(provider.getDisplayToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive for "Bearer" prefix', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('BEARER abc123')).toBe('abc123');
  });

  it('returns null for undefined header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null for non-Bearer auth schemes', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken('Digest abc123')).toBeNull();
  });

  it('returns null for malformed Bearer header', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });

  it('handles tokens with special characters', () => {
    expect(extractBearerToken('Bearer abc-123_def.456')).toBe('abc-123_def.456');
  });
});

describe('extractTokenFromRequest', () => {
  it('prefers bearer token from Authorization header', () => {
    expect(
      extractTokenFromRequest({
        authorization: 'Bearer from-header',
        url: '/ws?token=from-query',
      }),
    ).toBe('from-header');
  });

  it('falls back to token query parameter', () => {
    expect(extractTokenFromRequest({ url: '/ws?token=from-query' })).toBe('from-query');
  });

  it('can disable query-token fallback when required', () => {
    expect(
      extractTokenFromRequest({ url: '/ws?token=from-query', allowQueryToken: false }),
    ).toBeNull();
  });

  it('returns null when neither source has a token', () => {
    expect(extractTokenFromRequest({ url: '/ws' })).toBeNull();
    expect(extractTokenFromRequest({})).toBeNull();
  });
});
