import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPlugins } from '../../src/workflows/plugin-loader.js';
import { NODE_EXECUTORS } from '../../src/workflows/node-registry.js';

let tempHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-plugin-loader-'));
  originalHome = process.env['HOME'];
  process.env['HOME'] = tempHome;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

describe('loadPlugins', () => {
  it('returns no plugins when the manifest file does not exist', async () => {
    const result = await loadPlugins();
    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('registers a node executor from a plugin and skips reserved types', async () => {
    const viewportDir = path.join(tempHome, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });

    // Inline plugin module — writes to disk and is loaded via dynamic import.
    const pluginPath = path.join(viewportDir, 'http-plugin.mjs');
    await fs.writeFile(
      pluginPath,
      `export default {
        name: 'http-test',
        version: '1.0.0',
        nodes: [
          {
            type: 'http_request',
            execute: async () => ({ result: 'completed' }),
          },
          {
            type: 'shell', // reserved — should be rejected with a warning
            execute: async () => ({ result: 'completed' }),
          },
        ],
      };`,
      'utf-8',
    );

    await fs.writeFile(
      path.join(viewportDir, 'plugins.json'),
      JSON.stringify({
        plugins: [{ name: 'http-test', module: pluginPath }],
      }),
      'utf-8',
    );

    const result = await loadPlugins();
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.nodes).toBe(1); // 1 of 2 (shell rejected)
    expect(NODE_EXECUTORS.has('http_request')).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('skips plugin entries marked enabled: false without erroring', async () => {
    const viewportDir = path.join(tempHome, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });
    await fs.writeFile(
      path.join(viewportDir, 'plugins.json'),
      JSON.stringify({
        plugins: [{ name: 'disabled', module: '/non/existent/path.mjs', enabled: false }],
      }),
      'utf-8',
    );
    const result = await loadPlugins();
    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('captures import failures without throwing', async () => {
    const viewportDir = path.join(tempHome, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });
    await fs.writeFile(
      path.join(viewportDir, 'plugins.json'),
      JSON.stringify({
        plugins: [{ name: 'broken', module: path.join(viewportDir, 'does-not-exist.mjs') }],
      }),
      'utf-8',
    );
    const result = await loadPlugins();
    expect(result.loaded).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('broken');
  });
});
