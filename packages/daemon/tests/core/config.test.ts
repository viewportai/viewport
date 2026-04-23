import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  BUILT_IN_DEFAULTS,
  deepMerge,
  resolveConfig,
  ConfigManager,
  loadConfig,
  saveConfig,
} from '../../src/core/config.js';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import { claudeAgent } from '../../src/agents/claude.js';
import type { GitTrackerConfig } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  it('merges flat objects', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('deep-merges nested objects', () => {
    const result = deepMerge({ nested: { a: 1, b: 2 } }, { nested: { b: 3, c: 4 } });
    expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  it('replaces arrays (does not concatenate)', () => {
    const result = deepMerge({ arr: [1, 2, 3] }, { arr: [4, 5] });
    expect(result).toEqual({ arr: [4, 5] });
  });

  it('skips undefined values in source', () => {
    const result = deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 });
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it('handles multiple sources in order', () => {
    const result = deepMerge({ a: 1 }, { a: 2 }, { a: 3 });
    expect(result).toEqual({ a: 3 });
  });

  it('handles empty sources', () => {
    const result = deepMerge({ a: 1 }, {}, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('handles null source gracefully', () => {
    const result = deepMerge({ a: 1 }, null as any, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('ignores prototype pollution keys', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}') as Record<
      string,
      unknown
    >;
    const result = deepMerge({ safe: true }, payload);
    expect((result as Record<string, unknown>)['safe']).toBe(true);
    expect((result as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not deep-merge objects with non-standard prototypes', () => {
    const customProto = { inherited: true };
    const custom = Object.create(customProto) as Record<string, unknown>;
    custom['value'] = 3;

    const result = deepMerge({ nested: { safe: 1 } }, { nested: custom }) as Record<
      string,
      unknown
    >;
    const nested = result['nested'] as Record<string, unknown>;
    expect(nested['value']).toBe(3);
    expect(nested['safe']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  it('returns built-in defaults when no overrides', () => {
    const config = resolveConfig();
    expect(config.agent).toBe('claude');
    expect(config.gitTracker.enabled).toBe(true);
    // Without agent defaults, arrays are empty (framework-level only)
    expect(config.gitTracker.commitOn).toEqual([]);
    expect(config.permissions.autoApprove).toEqual([]);
    expect(config.trust).toBe('operator');
  });

  it('agent defaults provide tool names', () => {
    const agentDefaults = {
      gitTracker: {
        commitOn: ['Edit', 'Write', 'Bash'],
      } as GitTrackerConfig,
      permissions: {
        autoApprove: ['Read', 'Glob'],
        requireApproval: ['Edit', 'Write'],
        deny: [],
      },
    };
    const config = resolveConfig(agentDefaults);
    expect(config.gitTracker.commitOn).toEqual(['Edit', 'Write', 'Bash']);
    expect(config.permissions.autoApprove).toEqual(['Read', 'Glob']);
  });

  it('global defaults override agent defaults', () => {
    const agentDefaults = { model: 'claude-sonnet-4-6' };
    const config = resolveConfig(agentDefaults, { model: 'claude-opus-4-6' });
    expect(config.model).toBe('claude-opus-4-6');
    expect(config.agent).toBe('claude'); // untouched
  });

  it('directory config overrides global', () => {
    const config = resolveConfig(
      undefined,
      { model: 'claude-opus-4-6' },
      { model: 'claude-sonnet-4-6' },
    );
    expect(config.model).toBe('claude-sonnet-4-6');
  });

  it('session overrides win over everything', () => {
    const config = resolveConfig(
      { model: 'model-a' },
      { model: 'model-b' },
      { model: 'model-c' },
      { model: 'model-d' },
    );
    expect(config.model).toBe('model-d');
  });

  it('deep-merges nested configs', () => {
    const config = resolveConfig(undefined, undefined, {
      gitTracker: { maxCommitsPerSession: 100 } as Partial<GitTrackerConfig> as GitTrackerConfig,
    });
    // maxCommitsPerSession overridden
    expect(config.gitTracker.maxCommitsPerSession).toBe(100);
    // Other GitTracker fields preserved from defaults
    expect(config.gitTracker.enabled).toBe(true);
    expect(config.gitTracker.branchPrefix).toBe('viewport/session-');
  });

  it('replaces array configs entirely', () => {
    const config = resolveConfig(undefined, undefined, {
      permissions: { autoApprove: ['Read'], requireApproval: ['Bash'], deny: ['Write'] },
    });
    expect(config.permissions.autoApprove).toEqual(['Read']);
    expect(config.permissions.deny).toEqual(['Write']);
  });
});

// ---------------------------------------------------------------------------
// BUILT_IN_DEFAULTS
// ---------------------------------------------------------------------------

describe('BUILT_IN_DEFAULTS', () => {
  it('has agent-agnostic framework defaults', () => {
    expect(BUILT_IN_DEFAULTS.agent).toBe('claude');
    expect(BUILT_IN_DEFAULTS.trust).toBe('operator');
    expect(BUILT_IN_DEFAULTS.gitTracker.enabled).toBe(true);
    // Tool names are empty — they come from agent definitions, not framework
    expect(BUILT_IN_DEFAULTS.gitTracker.commitOn).toEqual([]);
    expect(BUILT_IN_DEFAULTS.permissions.autoApprove).toEqual([]);
    expect(BUILT_IN_DEFAULTS.permissions.requireApproval).toEqual([]);
    expect(BUILT_IN_DEFAULTS.permissions.deny).toEqual([]);
    // Framework config still present
    expect(BUILT_IN_DEFAULTS.gitTracker.ignore).toContain('.env');
    expect(BUILT_IN_DEFAULTS.costCapUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config file I/O + ConfigManager
// ---------------------------------------------------------------------------

describe('Config I/O', () => {
  let tmpDir: string;
  let originalHome: string;
  let originalProjectConfigDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-config-test-'));
    originalHome = process.env['HOME'] ?? '';
    originalProjectConfigDir = process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
    process.env['HOME'] = tmpDir;
    delete process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    if (originalProjectConfigDir === undefined) {
      delete process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
    } else {
      process.env['VIEWPORT_PROJECT_CONFIG_DIR'] = originalProjectConfigDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loadConfig returns empty object when no config file', async () => {
    const config = await loadConfig();
    expect(config).toEqual({});
  });

  it('saveConfig creates directory and writes file', async () => {
    await saveConfig({ machineId: 'test-machine', defaults: { agent: 'claude' } });

    const configPath = path.join(tmpDir, '.viewport', 'config.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.machineId).toBe('test-machine');
    expect(parsed.defaults.agent).toBe('claude');

    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('loadConfig reads back what saveConfig wrote', async () => {
    await saveConfig({ machineId: 'roundtrip' });
    const config = await loadConfig();
    expect(config.machineId).toBe('roundtrip');
  });

  it('loadConfig merges a project override on top of the global config', async () => {
    await saveConfig({
      daemon: {
        server: { url: 'https://getviewport.com' },
        relay: {
          enabled: true,
          serverUrl: 'https://app.getviewport.com',
          endpoint: 'wss://relay.getviewport.com/ws',
        },
      },
    });

    const projectConfigDir = path.join(tmpDir, 'repo', '.viewport');
    await fs.mkdir(projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({
        daemon: {
          server: { url: 'https://getviewport.test' },
          relay: {
            serverUrl: 'https://getviewport.test',
            endpoint: 'wss://getviewport.test:7781/ws',
          },
        },
      }),
      'utf-8',
    );

    process.env['VIEWPORT_PROJECT_CONFIG_DIR'] = projectConfigDir;
    const config = await loadConfig();
    expect(config.daemon?.server?.url).toBe('https://getviewport.test');
    expect(config.daemon?.relay?.serverUrl).toBe('https://getviewport.test');
    expect(config.daemon?.relay?.endpoint).toBe('wss://getviewport.test:7781/ws');
  });

  it('loadConfig throws on malformed JSON with actionable error', async () => {
    const dir = path.join(tmpDir, '.viewport');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), '{ bad json !!!', 'utf-8');

    await expect(loadConfig()).rejects.toThrow('Invalid viewport config JSON');
  });

  it('loadConfig throws on schema-invalid config', async () => {
    const dir = path.join(tmpDir, '.viewport');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        defaults: {
          agent: 42,
        },
      }),
      'utf-8',
    );

    await expect(loadConfig()).rejects.toThrow('Invalid viewport config schema');
  });

  it('migrates deprecated daemon relay keys and persists the sanitized config', async () => {
    const dir = path.join(tmpDir, '.viewport');
    await fs.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        daemon: {
          relay: {
            enabled: true,
            endpoint: 'ws://127.0.0.1:7781/ws',
            serverUrl: 'http://127.0.0.1:8787',
            workspaceId: 'workspace_demo',
            installId: 'install_demo',
            issueToken: 'install-issue-token',
            enrollToken: 'workspace-enroll-token',
            tlsVerify: '0',
          },
        },
      }),
      'utf-8',
    );

    const config = await loadConfig();
    expect(config.daemon?.relay?.issueToken).toBe('install-issue-token');
    expect((config.daemon?.relay as Record<string, unknown>)['enrollToken']).toBeUndefined();

    const rewritten = JSON.parse(await fs.readFile(configPath, 'utf-8')) as {
      daemon?: { relay?: Record<string, unknown> };
    };
    expect(rewritten.daemon?.relay?.['enrollToken']).toBeUndefined();
  });
});

describe('ConfigManager', () => {
  let tmpDir: string;
  let originalHome: string;
  let originalProjectConfigDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-cfgmgr-test-'));
    originalHome = process.env['HOME'] ?? '';
    originalProjectConfigDir = process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
    process.env['HOME'] = tmpDir;
    delete process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    if (originalProjectConfigDir === undefined) {
      delete process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
    } else {
      process.env['VIEWPORT_PROJECT_CONFIG_DIR'] = originalProjectConfigDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws if not loaded', () => {
    const mgr = new ConfigManager();
    expect(() => mgr.getConfig()).toThrow('ConfigManager not loaded');
  });

  it('loads config and resolves session config', async () => {
    const mgr = new ConfigManager();
    await mgr.load();

    const config = mgr.resolveSessionConfig();
    expect(config.agent).toBe('claude');
    expect(config.gitTracker.enabled).toBe(true);
  });

  it('resolves with agent defaults from registry', async () => {
    const registry = new AgentRegistry();
    registry.register(claudeAgent);

    const mgr = new ConfigManager();
    mgr.setAgentRegistry(registry);
    await mgr.load();

    const config = mgr.resolveSessionConfig();
    // Now agent defaults inject Claude-specific tool names
    expect(config.gitTracker.commitOn).toContain('Edit');
    expect(config.gitTracker.commitOn).toContain('Bash');
    expect(config.permissions.autoApprove).toContain('Read');
    expect(config.permissions.autoApprove).toContain('Grep');
    expect(config.permissions.requireApproval).toContain('Edit');
  });

  it('resolves per-directory config', async () => {
    await saveConfig({
      defaults: { model: 'claude-opus-4-6' },
      directories: {
        'dir-1': { path: '/home/me/project', config: { model: 'claude-sonnet-4-6' } },
      },
    });

    const mgr = new ConfigManager();
    await mgr.load();

    const config = mgr.resolveSessionConfig('dir-1');
    expect(config.model).toBe('claude-sonnet-4-6');

    // Non-existent directory falls back to global
    const fallback = mgr.resolveSessionConfig('dir-unknown');
    expect(fallback.model).toBe('claude-opus-4-6');
  });

  it('registers and unregisters directories', async () => {
    const mgr = new ConfigManager();
    await mgr.load();

    await mgr.registerDirectory('my-proj', '/home/me/project', { model: 'claude-sonnet-4-6' });

    const dirs = mgr.getDirectories();
    expect(dirs['my-proj']).toBeDefined();
    expect(dirs['my-proj']?.path).toBe('/home/me/project');

    await mgr.unregisterDirectory('my-proj');
    expect(mgr.getDirectories()['my-proj']).toBeUndefined();
  });

  it('persists directory registration to disk', async () => {
    const mgr = new ConfigManager();
    await mgr.load();
    await mgr.registerDirectory('proj', '/home/me/proj');

    // Load fresh manager to verify persistence
    const mgr2 = new ConfigManager();
    await mgr2.load();
    expect(mgr2.getDirectories()['proj']?.path).toBe('/home/me/proj');
  });

  it('returns hostname as default machine ID', async () => {
    const mgr = new ConfigManager();
    await mgr.load();
    expect(mgr.getMachineId()).toBe(os.hostname());
  });

  it('returns configured machine ID', async () => {
    await saveConfig({ machineId: 'custom-machine' });
    const mgr = new ConfigManager();
    await mgr.load();
    expect(mgr.getMachineId()).toBe('custom-machine');
  });

  it('sets global defaults', async () => {
    const mgr = new ConfigManager();
    await mgr.load();
    await mgr.setDefaults({ model: 'claude-opus-4-6' });

    const config = mgr.resolveSessionConfig();
    expect(config.model).toBe('claude-opus-4-6');
  });

  it('rejects insecure relay runtime config on setDaemonConfig', async () => {
    const mgr = new ConfigManager();
    await mgr.load();

    await expect(
      mgr.setDaemonConfig({
        profile: 'lan',
        relay: {
          enabled: true,
          endpoint: 'ws://relay.getviewport.test/ws',
          tlsVerify: '0',
          signingKeys: {
            k1: 'a'.repeat(32),
          },
        },
      }),
    ).rejects.toThrow('relay tls verify');
  });

  it('accepts local relay config when signing keys are present', async () => {
    const mgr = new ConfigManager();
    await mgr.load();

    await expect(
      mgr.setDaemonConfig({
        profile: 'local',
        relay: {
          enabled: true,
          endpoint: 'ws://127.0.0.1:7781/ws',
          tlsVerify: 'auto',
          signingKeys: {
            k1: 'b'.repeat(32),
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('clears persisted optional relay credentials when set to undefined', async () => {
    const mgr = new ConfigManager();
    await mgr.load();

    await mgr.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://relay.getviewport.com/ws',
        serverUrl: 'https://app.getviewport.com',
        workspaceId: 'workspace_demo',
        installId: 'install_demo',
        issueToken: 'install-issue-token',
        tlsVerify: 'auto',
      },
    });

    await mgr.setDaemonConfig({
      relay: {
        workspaceId: 'workspace_new',
        installId: 'install_new',
        issueToken: 'install-issue-token-new',
      },
    });

    const relay = mgr.getDaemonConfig()?.relay;
    expect(relay?.workspaceId).toBe('workspace_new');
    expect(relay?.installId).toBe('install_new');
    expect(relay?.issueToken).toBe('install-issue-token-new');

    const reloaded = new ConfigManager();
    await reloaded.load();
    expect(reloaded.getDaemonConfig()?.relay?.issueToken).toBe('install-issue-token-new');
  });
});
