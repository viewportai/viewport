import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineExpression,
  defineNode,
  definePlugin,
  PluginManifestSchema,
  WORKFLOW_PLUGIN_CONTRACT_VERSION,
} from '../src/index.js';

describe('workflow-sdk', () => {
  it('exports the plugin contract version', () => {
    expect(WORKFLOW_PLUGIN_CONTRACT_VERSION).toBe('viewport.workflow-plugin/v1');
  });

  describe('defineNode', () => {
    it('returns the definition unchanged when the type is not reserved', () => {
      const definition = defineNode({
        type: 'http_request',
        schema: z.object({ url: z.string() }),
        async execute(config) {
          return { status: 'completed', output: config.url };
        },
      });
      expect(definition.type).toBe('http_request');
    });

    it('throws when a plugin tries to claim a built-in node type', () => {
      expect(() =>
        defineNode({
          type: 'shell',
          schema: z.object({}),
          async execute() {
            return { status: 'completed' };
          },
        }),
      ).toThrow(/reserved by the runtime/);
    });
  });

  describe('defineExpression', () => {
    it('accepts a valid JSONata identifier', () => {
      const expression = defineExpression({
        name: 'slugify',
        evaluate: (value: unknown) => String(value).toLowerCase(),
      });
      expect(expression.name).toBe('slugify');
    });

    it('rejects names with invalid characters', () => {
      expect(() =>
        defineExpression({
          name: 'has space',
          evaluate: () => '',
        }),
      ).toThrow(/valid JSONata identifier/);
    });
  });

  describe('definePlugin', () => {
    it('accepts a kebab-case name', () => {
      const plugin = definePlugin({
        name: 'viewport-http',
        version: '1.0.0',
        contract: WORKFLOW_PLUGIN_CONTRACT_VERSION,
        nodes: [],
      });
      expect(plugin.name).toBe('viewport-http');
    });

    it('rejects names that contain uppercase or whitespace', () => {
      expect(() =>
        definePlugin({ name: 'Viewport HTTP', version: '1.0.0' }),
      ).toThrow(/lowercase/);
    });
  });

  describe('PluginManifestSchema', () => {
    it('parses a manifest with one plugin entry', () => {
      const parsed = PluginManifestSchema.parse({
        plugins: [{ name: 'viewport-http', module: './plugins/http/index.js' }],
      });
      expect(parsed.plugins).toHaveLength(1);
      expect(parsed.plugins[0]?.module).toBe('./plugins/http/index.js');
    });

    it('defaults plugins to an empty array when the field is absent', () => {
      const parsed = PluginManifestSchema.parse({});
      expect(parsed.plugins).toEqual([]);
    });
  });
});
