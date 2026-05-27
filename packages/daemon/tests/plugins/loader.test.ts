import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadPluginAgents, listPlugins, pluginsDir } from '../../src/plugins/loader.js';

describe('Plugin loader', () => {
  let tmpDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-plugins-test-'));
    originalHome = process.env['HOME'] ?? '';
    process.env['HOME'] = tmpDir;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pluginsDir returns ~/.viewport/plugins', () => {
    expect(pluginsDir()).toBe(path.join(tmpDir, '.viewport', 'plugins'));
  });

  it('returns empty array when no plugins installed', async () => {
    const plugins = await loadPluginAgents();
    expect(plugins).toEqual([]);
  });

  it('returns empty list when plugins dir does not exist', async () => {
    const manifests = await listPlugins();
    expect(manifests).toEqual([]);
  });

  it('discovers a valid plugin from plugins dir', async () => {
    // Create a mock plugin
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-test');
    await fs.mkdir(pluginDir, { recursive: true });

    // Write package.json with viewport metadata
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-test',
        version: '1.0.0',
        main: 'index.js',
        viewport: { type: 'agent', agentId: 'test-agent' },
      }),
    );

    // Write the plugin module
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      `
      module.exports.definition = {
        id: 'test-agent',
        displayName: 'Test Agent',
        tier: 'pty',
        defaults: { commitOn: [], autoApprove: [], requireApproval: [], deny: [] },
        capabilities: {
          structuredToolCalls: false,
          permissionCallbacks: false,
          tokenUsage: false,
          resume: false,
          extendedThinking: false,
        },
        detection: {
          check: async () => true,
          description: 'Test agent',
        },
        createAdapter: async () => null,
      };
      `,
    );

    const plugins = await loadPluginAgents();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.definition.id).toBe('test-agent');
    expect(plugins[0]!.definition.displayName).toBe('Test Agent');
    expect(plugins[0]!.manifest.name).toBe('viewport-agent-test');
  });

  it('lists plugins without loading them', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-list');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-list',
        version: '2.0.0',
        viewport: { type: 'agent', agentId: 'list-test' },
      }),
    );

    const manifests = await listPlugins();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.name).toBe('viewport-agent-list');
    expect(manifests[0]!.viewport.agentId).toBe('list-test');
  });

  it('skips packages without viewport metadata', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-bad');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'viewport-agent-bad', version: '1.0.0' }),
    );

    const manifests = await listPlugins();
    expect(manifests).toEqual([]);
  });

  it('skips packages with wrong viewport type', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-wrong');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-wrong',
        version: '1.0.0',
        viewport: { type: 'theme', agentId: 'wrong' },
      }),
    );

    const manifests = await listPlugins();
    expect(manifests).toEqual([]);
  });

  it('rejects plugin manifests with unsafe agent ids', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-unsafe-id');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-unsafe-id',
        version: '1.0.0',
        viewport: { type: 'agent', agentId: '../unsafe' },
      }),
    );

    const manifests = await listPlugins();
    expect(manifests).toEqual([]);
  });

  it('handles scoped packages (@viewport/agent-*)', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', '@viewport', 'agent-scoped');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: '@viewport/agent-scoped',
        version: '1.0.0',
        viewport: { type: 'agent', agentId: 'scoped-agent' },
      }),
    );

    const manifests = await listPlugins();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.viewport.agentId).toBe('scoped-agent');
  });

  it('deduplicates plugins by agentId', async () => {
    // Create two plugins with the same agentId
    for (const name of ['viewport-agent-dup1', 'viewport-agent-dup2']) {
      const pluginDir = path.join(pluginsDir(), 'node_modules', name);
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          main: 'index.js',
          viewport: { type: 'agent', agentId: 'duplicate' },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, 'index.js'),
        `module.exports.definition = {
          id: 'duplicate',
          displayName: '${name}',
          tier: 'pty',
          defaults: { commitOn: [], autoApprove: [], requireApproval: [], deny: [] },
          capabilities: { structuredToolCalls: false, permissionCallbacks: false, tokenUsage: false, resume: false, extendedThinking: false },
          detection: { check: async () => true, description: 'test' },
          createAdapter: async () => null,
        };`,
      );
    }

    const plugins = await loadPluginAgents();
    // Only one should load
    expect(plugins).toHaveLength(1);
  });

  it('skips plugins that fail to load', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-broken');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-broken',
        version: '1.0.0',
        main: 'index.js',
        viewport: { type: 'agent', agentId: 'broken' },
      }),
    );
    // Write broken JS
    await fs.writeFile(path.join(pluginDir, 'index.js'), 'INVALID JAVASCRIPT !!!{{{');

    const plugins = await loadPluginAgents();
    expect(plugins).toEqual([]);
  });

  it('rejects plugin main entries that escape the plugin directory', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-path-escape');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-path-escape',
        version: '1.0.0',
        main: '../../../tmp/evil.js',
        viewport: { type: 'agent', agentId: 'path-escape' },
      }),
    );

    const plugins = await loadPluginAgents();
    expect(plugins).toEqual([]);
  });

  it('rejects plugin main entries that escape via symlink', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-plugin-outside-'));
    try {
      const outsideEntry = path.join(outsideDir, 'outside-entry.js');
      await fs.writeFile(
        outsideEntry,
        `module.exports.definition = {
        id: 'outside-escape',
        displayName: 'Outside Escape',
        tier: 'pty',
        defaults: { commitOn: [], autoApprove: [], requireApproval: [], deny: [] },
        capabilities: {
          structuredToolCalls: false,
          permissionCallbacks: false,
          tokenUsage: false,
          resume: false,
          extendedThinking: false,
        },
        detection: { check: async () => true, description: 'outside escape' },
        createAdapter: async () => null,
      };`,
      );

      const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-symlink-escape');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'viewport-agent-symlink-escape',
          version: '1.0.0',
          main: 'symlink-entry.js',
          viewport: { type: 'agent', agentId: 'symlink-escape' },
        }),
      );
      await fs.symlink(outsideEntry, path.join(pluginDir, 'symlink-entry.js'));

      const plugins = await loadPluginAgents();
      expect(plugins).toEqual([]);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips plugins with incomplete definitions', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-incomplete');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-incomplete',
        version: '1.0.0',
        main: 'index.js',
        viewport: { type: 'agent', agentId: 'incomplete' },
      }),
    );
    // Export an incomplete definition (missing required fields)
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      `module.exports.definition = { id: 'incomplete' };`,
    );

    const plugins = await loadPluginAgents();
    expect(plugins).toEqual([]);
  });

  it('rejects plugins whose exported agent id does not match the manifest', async () => {
    const pluginDir = path.join(pluginsDir(), 'node_modules', 'viewport-agent-mismatch');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'viewport-agent-mismatch',
        version: '1.0.0',
        main: 'index.js',
        viewport: { type: 'agent', agentId: 'manifest-agent' },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      `module.exports.definition = {
        id: 'exported-agent',
        displayName: 'Mismatch',
        tier: 'pty',
        defaults: { commitOn: [], autoApprove: [], requireApproval: [], deny: [] },
        capabilities: { structuredToolCalls: false, permissionCallbacks: false, tokenUsage: false, resume: false, extendedThinking: false },
        detection: { check: async () => true, description: 'mismatch' },
        createAdapter: async () => null,
      };`,
    );

    const plugins = await loadPluginAgents();
    expect(plugins).toEqual([]);
  });
});
