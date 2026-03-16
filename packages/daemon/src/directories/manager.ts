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
    return Object.entries(dirs).map(([id, entry]) =>
      this.toDirectoryInfo(id, entry.path, entry.config),
    );
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
    const id = DirectoryManager.idFromPath(dirPath);
    return this.get(id);
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
}
