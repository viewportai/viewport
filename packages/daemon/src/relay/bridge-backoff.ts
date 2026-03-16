import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './bridge-constants.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeBackoffMs(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(RECONNECT_MAX_MS, exp + jitter);
}
