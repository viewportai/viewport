import { describe, expect } from 'vitest';
import {
  BifrostGatewayProvider,
  LiteLlmGatewayProvider,
} from '../src/index.js';
import { runGatewayProviderConformance } from '../src/conformance/gateway-provider-conformance.js';

describe('reference gateway adapters', () => {
  runGatewayProviderConformance({
    name: 'LiteLLM',
    createProvider: (baseUrl) => new LiteLlmGatewayProvider({ baseUrl }),
    assertCapturedRequest: (captured) => {
      expect(captured.path).toBe('/v1/chat/completions');
      expect(captured.body.api_key).toBe('real-provider-key');
      expect(captured.body.metadata).toMatchObject({
        user_api_key_org_id: 'tenant_a',
        user_api_key_team_id: 'workspace_a',
        viewport_agent_id: 'agent_a',
        viewport_run_id: 'run_a',
        viewport_policy_hash: 'sha256:policy',
        viewport_request_id: 'request_a',
      });
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
