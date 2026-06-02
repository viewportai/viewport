import { describe, expect } from 'vitest';
import {
  BifrostGatewayProvider,
  LiteLlmGatewayProvider,
  runGatewayProviderConformance,
} from '../src/index.js';

describe('reference gateway adapters', () => {
  runGatewayProviderConformance({
    name: 'LiteLLM',
    createProvider: (baseUrl) => new LiteLlmGatewayProvider({ baseUrl }),
    assertCapturedRequest: (captured) => {
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.body.api_key).toBe('real-provider-key');
      expect(captured.headers['x-viewport-run-id']).toBe('run_a');
      expect(captured.headers['x-viewport-policy-hash']).toBe('sha256:policy');
    },
  });

  runGatewayProviderConformance({
    name: 'Bifrost reference',
    createProvider: (baseUrl) => new BifrostGatewayProvider({ baseUrl }),
    assertCapturedRequest: (captured) => {
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.body).not.toHaveProperty('api_key');
      expect(captured.headers.authorization).toBe('Bearer real-provider-key');
      expect(captured.headers['x-viewport-run-id']).toBe('run_a');
    },
  });
});
