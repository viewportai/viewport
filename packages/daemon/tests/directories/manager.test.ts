import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DirectoryManager } from '../../src/directories/manager.js';
import { ConfigManager } from '../../src/core/config.js';

describe('DirectoryManager', () => {
  let tempHome: string;
  let originalHome: string;
  let configManager: ConfigManager;
  let manager: DirectoryManager;
  let testDir: string;

  beforeEach(async () => {
    // Use a temp HOME so config files don't touch real ~/.viewport
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-dir-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;

    configManager = new ConfigManager();
    await configManager.load();
    manager = new DirectoryManager(configManager);

    // Create a real directory to register
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-project-'));
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // idFromPath
  // ---------------------------------------------------------------------------

  it('generates stable IDs from paths', () => {
    const id1 = DirectoryManager.idFromPath('/home/user/project');
    const id2 = DirectoryManager.idFromPath('/home/user/project');
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(12);
  });

  it('generates different IDs for different paths', () => {
    const id1 = DirectoryManager.idFromPath('/home/user/project-a');
    const id2 = DirectoryManager.idFromPath('/home/user/project-b');
    expect(id1).not.toBe(id2);
  });

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------

  it('registers a directory', async () => {
    const info = await manager.register(testDir);

    expect(info.id).toHaveLength(12);
    expect(info.path).toBe(path.resolve(testDir));
    expect(info.activeSessions).toEqual([]);
  });

  it('registers a directory with config overrides', async () => {
    const info = await manager.register(testDir, { agent: 'codex' });

    expect(info.config).toEqual({ agent: 'codex' });
  });

  it('persists registration to config', async () => {
    await manager.register(testDir);

    // Reload config and verify
    const freshConfig = new ConfigManager();
    await freshConfig.load();
    const dirs = freshConfig.getDirectories();
    const entries = Object.values(dirs);
    expect(entries.length).toBe(1);
    expect(entries[0]!.path).toBe(path.resolve(testDir));
  });

  it('throws when registering a non-existent path', async () => {
    await expect(manager.register('/nonexistent/path')).rejects.toThrow();
  });

  it('throws when registering a file (not directory)', async () => {
    const filePath = path.join(testDir, 'file.txt');
    await fs.writeFile(filePath, 'hello');
    await expect(manager.register(filePath)).rejects.toThrow('Not a directory');
  });

  // ---------------------------------------------------------------------------
  // list / get / getByPath
  // ---------------------------------------------------------------------------

  it('lists registered directories', async () => {
    await manager.register(testDir);
    const dirs = manager.list();

    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.path).toBe(path.resolve(testDir));
  });

  it('gets a directory by ID', async () => {
    const registered = await manager.register(testDir);
    const found = manager.get(registered.id);

    expect(found).toBeDefined();
    expect(found!.path).toBe(registered.path);
  });

  it('returns undefined for unknown ID', () => {
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  it('finds a directory by path', async () => {
    await manager.register(testDir);
    const found = manager.getByPath(testDir);

    expect(found).toBeDefined();
    expect(found!.path).toBe(path.resolve(testDir));
  });

  it('finds path aliases and does not auto-register duplicate directory rows', async () => {
    await configManager.registerDirectory('alias-dir', path.resolve(testDir), { agent: 'codex' });

    const found = manager.getByPath(testDir);
    const registered = await manager.register(testDir);

    expect(found).toMatchObject({
      id: 'alias-dir',
      path: path.resolve(testDir),
    });
    expect(registered).toMatchObject({
      id: 'alias-dir',
      path: path.resolve(testDir),
    });
    expect(Object.entries(configManager.getDirectories())).toHaveLength(1);
  });

  it('dedupes duplicate path aliases in public directory lists', async () => {
    const canonicalId = DirectoryManager.idFromPath(testDir);
    await configManager.registerDirectory('alias-dir', path.resolve(testDir));
    await configManager.registerDirectory(canonicalId, path.resolve(testDir));

    const dirs = manager.list();

    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({
      id: canonicalId,
      path: path.resolve(testDir),
    });
  });

  it('returns undefined for unregistered path', () => {
    expect(manager.getByPath('/not/registered')).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // unregister
  // ---------------------------------------------------------------------------

  it('unregisters a directory', async () => {
    const info = await manager.register(testDir);
    await manager.unregister(info.id);

    expect(manager.get(info.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // session tracking
  // ---------------------------------------------------------------------------

  it('tracks active sessions per directory', async () => {
    const info = await manager.register(testDir);

    manager.addSession(info.id, 'session-1');
    manager.addSession(info.id, 'session-2');

    const dir = manager.get(info.id);
    expect(dir!.activeSessions).toContain('session-1');
    expect(dir!.activeSessions).toContain('session-2');
  });

  it('removes sessions from directory', async () => {
    const info = await manager.register(testDir);

    manager.addSession(info.id, 'session-1');
    manager.addSession(info.id, 'session-2');
    manager.removeSession(info.id, 'session-1');

    const dir = manager.get(info.id);
    expect(dir!.activeSessions).toEqual(['session-2']);
  });

  it('handles removing session from unknown directory', () => {
    // Should not throw
    manager.removeSession('unknown', 'session-1');
  });

  it('clears active sessions on unregister', async () => {
    const info = await manager.register(testDir);
    manager.addSession(info.id, 'session-1');

    await manager.unregister(info.id);

    // Re-register — sessions should be empty
    const reregistered = await manager.register(testDir);
    expect(reregistered.activeSessions).toEqual([]);
  });
});
