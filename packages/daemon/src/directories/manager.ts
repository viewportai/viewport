/**
 * DirectoryManager — registers and manages project directories.
 *
 * Each directory gets a unique ID (hash of its path), optional per-directory
 * config overrides, and tracks active session IDs. Persistence is delegated
 * to ConfigManager.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConfigManager } from '../core/config.js';
import type { DirectoryInfo, SessionConfig } from '../core/types.js';

export class DirectoryManager {
  private activeSessionsByDir = new Map<string, Set<string>>();

  constructor(private configManager: ConfigManager) {}

  /** Generate a stable, short ID from a directory path. */
  static idFromPath(dirPath: string): string {
    const normalized = path.resolve(dirPath);
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  }

  /** Register a directory for monitoring. */
  async register(dirPath: string, config?: Partial<SessionConfig>): Promise<DirectoryInfo> {
    const resolved = path.resolve(dirPath);

    // Verify directory exists
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }

    const existing = this.findByResolvedPath(resolved);
    if (existing) return existing;

    const id = DirectoryManager.idFromPath(resolved);
    await this.configManager.registerDirectory(id, resolved, config);

    return this.toDirectoryInfo(id, resolved, config);
  }

  /** Unregister a directory. */
  async unregister(directoryId: string): Promise<void> {
    this.activeSessionsByDir.delete(directoryId);
    await this.configManager.unregisterDirectory(directoryId);
  }

  /** List all registered directories. */
  list(): DirectoryInfo[] {
    const dirs = this.configManager.getDirectories();
    const byResolvedPath = new Map<string, DirectoryInfo>();
    for (const [id, entry] of Object.entries(dirs)) {
      const info = this.toDirectoryInfo(id, entry.path, entry.config);
      const key = path.resolve(entry.path);
      byResolvedPath.set(key, chooseDirectoryAlias(byResolvedPath.get(key), info));
    }
    return [...byResolvedPath.values()];
  }

  /** Get a directory by ID. */
  get(directoryId: string): DirectoryInfo | undefined {
    const dirs = this.configManager.getDirectories();
    const entry = dirs[directoryId];
    if (!entry) return undefined;
    return this.toDirectoryInfo(directoryId, entry.path, entry.config);
  }

  /** Find a directory by its filesystem path. */
  getByPath(dirPath: string): DirectoryInfo | undefined {
    return this.findByResolvedPath(path.resolve(dirPath));
  }

  /** Track a session as active in a directory. */
  addSession(directoryId: string, sessionId: string): void {
    let sessions = this.activeSessionsByDir.get(directoryId);
    if (!sessions) {
      sessions = new Set();
      this.activeSessionsByDir.set(directoryId, sessions);
    }
    sessions.add(sessionId);
  }

  /** Remove a session from a directory's active list. */
  removeSession(directoryId: string, sessionId: string): void {
    const sessions = this.activeSessionsByDir.get(directoryId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.activeSessionsByDir.delete(directoryId);
      }
    }
  }

  private toDirectoryInfo(
    id: string,
    dirPath: string,
    config?: Partial<SessionConfig>,
  ): DirectoryInfo {
    const sessions = this.activeSessionsByDir.get(id);
    return {
      id,
      path: dirPath,
      config,
      activeSessions: sessions ? [...sessions] : [],
    };
  }

  private findByResolvedPath(resolvedPath: string): DirectoryInfo | undefined {
    const dirs = this.configManager.getDirectories();
    const canonicalId = DirectoryManager.idFromPath(resolvedPath);
    const canonicalEntry = dirs[canonicalId];
    if (canonicalEntry && path.resolve(canonicalEntry.path) === resolvedPath) {
      return this.toDirectoryInfo(canonicalId, canonicalEntry.path, canonicalEntry.config);
    }

    let match: DirectoryInfo | undefined;
    for (const [id, entry] of Object.entries(dirs)) {
      if (path.resolve(entry.path) !== resolvedPath) continue;
      match = chooseDirectoryAlias(match, this.toDirectoryInfo(id, entry.path, entry.config));
    }
    return match;
  }
}

function chooseDirectoryAlias(
  current: DirectoryInfo | undefined,
  candidate: DirectoryInfo,
): DirectoryInfo {
  if (!current) return candidate;
  const candidateHasActive = candidate.activeSessions.length > 0;
  const currentHasActive = current.activeSessions.length > 0;
  if (candidateHasActive !== currentHasActive) {
    return candidateHasActive ? candidate : current;
  }

  const candidateHasConfig = Boolean(candidate.config && Object.keys(candidate.config).length > 0);
  const currentHasConfig = Boolean(current.config && Object.keys(current.config).length > 0);
  if (candidateHasConfig !== currentHasConfig) {
    return candidateHasConfig ? candidate : current;
  }

  const candidateCanonical = candidate.id === DirectoryManager.idFromPath(candidate.path);
  const currentCanonical = current.id === DirectoryManager.idFromPath(current.path);
  if (candidateCanonical !== currentCanonical) {
    return candidateCanonical ? candidate : current;
  }

  return candidate.id < current.id ? candidate : current;
}
