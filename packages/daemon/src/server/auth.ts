/**
 * Authentication module for the Viewport daemon.
 *
 * Local mode stores an auth token in the daemon config directory.
 * Relay-backed access still terminates at the local daemon; runtime admission
 * to the relay is handled separately by control-plane-issued credentials.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { configDir } from '../core/config.js';

export interface AuthProvider {
  /** Validate a token/key. Returns true if valid. */
  validate(token: string): Promise<boolean>;
  /** Get the current token (for display in terminal). Null if N/A. */
  getDisplayToken(): string | null;
}

/** Local file-based auth. Token saved to ~/.viewport/auth-token */
export class LocalAuthProvider implements AuthProvider {
  private token: string | null = null;

  async initialize(): Promise<void> {
    const tokenPath = path.join(configDir(), 'auth-token');
    try {
      this.token = (await fs.readFile(tokenPath, 'utf-8')).trim();
    } catch {
      // Generate new token
      this.token = crypto.randomBytes(32).toString('hex');
      await fs.mkdir(configDir(), { recursive: true });
      await fs.writeFile(tokenPath, this.token + '\n', { mode: 0o600 });
    }
  }

  async validate(token: string): Promise<boolean> {
    if (this.token === null) return false;
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    const compareLength = Math.max(a.length, b.length, 1);
    const paddedA = Buffer.alloc(compareLength);
    const paddedB = Buffer.alloc(compareLength);
    a.copy(paddedA);
    b.copy(paddedB);
    const equal = crypto.timingSafeEqual(paddedA, paddedB);
    return equal && a.length === b.length;
  }

  getDisplayToken(): string | null {
    return this.token;
  }
}

/** No-op auth that allows everything. Used with --no-auth flag. */
export class NoopAuthProvider implements AuthProvider {
  async validate(): Promise<boolean> {
    return true;
  }
  getDisplayToken(): string | null {
    return null;
  }
}

/** Extract Bearer token from Authorization header. */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function extractTokenFromRequest(input: {
  authorization?: string;
  url?: string;
  allowQueryToken?: boolean;
}): string | null {
  const fromHeader = extractBearerToken(input.authorization);
  if (fromHeader) return fromHeader;

  // Browser WebSocket upgrades do not always carry Authorization headers cleanly.
  // Keep query-token fallback as the narrow transport escape hatch, not the primary path.
  // (Authorization headers are not always available on WS upgrades in browser clients).
  // Tradeoff: URL tokens can appear in logs/history; prefer Authorization headers whenever possible.
  if (input.allowQueryToken === false) return null;
  if (!input.url) return null;
  try {
    const parsed = new URL(input.url, 'http://localhost');
    const fromQuery = parsed.searchParams.get('token');
    return fromQuery?.trim() || null;
  } catch {
    return null;
  }
}
