import type { ContextKeyStore } from './local-edge-types.js';

const KEY_STORE_ENV_KEYS = ['VIEWPORT_CONTEXT_KEY_STORE', 'VPD_CONTEXT_KEY_STORE'];

export function resolveContextKeyStore(raw?: string): ContextKeyStore {
  if (raw) return parseContextKeyStore(raw);

  for (const key of KEY_STORE_ENV_KEYS) {
    const value = process.env[key];
    if (value) return parseContextKeyStore(value);
  }

  return defaultContextKeyStore();
}

export function defaultContextKeyStore(platform = process.platform): ContextKeyStore {
  void platform;
  return 'file';
}

function parseContextKeyStore(raw: string): ContextKeyStore {
  if (raw === 'file' || raw === 'macos-keychain') return raw;
  throw new Error(`Unsupported context key store: ${raw}`);
}
