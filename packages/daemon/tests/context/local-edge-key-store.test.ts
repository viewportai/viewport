import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultContextKeyStore,
  resolveContextKeyStore,
} from '../../src/context/local-edge-key-store.js';

describe('context key-store resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to file storage until keychain availability can be proven non-interactively', () => {
    expect(defaultContextKeyStore('darwin')).toBe('file');
    expect(defaultContextKeyStore('linux')).toBe('file');
    expect(defaultContextKeyStore('win32')).toBe('file');
  });

  it('lets explicit flags and environment override the production default', () => {
    expect(resolveContextKeyStore('file')).toBe('file');

    vi.stubEnv('VIEWPORT_CONTEXT_KEY_STORE', 'file');
    expect(resolveContextKeyStore()).toBe('file');

    vi.stubEnv('VIEWPORT_CONTEXT_KEY_STORE', '');
    vi.stubEnv('VPD_CONTEXT_KEY_STORE', 'macos-keychain');
    expect(resolveContextKeyStore()).toBe('macos-keychain');
  });

  it('rejects unsupported key-store names before writing local context', () => {
    expect(() => resolveContextKeyStore('plaintext')).toThrow(/Unsupported context key store/);
  });
});
