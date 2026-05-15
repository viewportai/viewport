import { describe, expect, it } from 'vitest';
import { customCommandAgentFromEnv } from '../../src/agents/custom-command.js';

describe('custom command agent registration', () => {
  it('is disabled unless a command is configured', () => {
    expect(customCommandAgentFromEnv({})).toBeNull();
  });

  it('creates a PTY-backed custom command agent from environment config', async () => {
    const definition = customCommandAgentFromEnv({
      VIEWPORT_CUSTOM_AGENT_COMMAND: 'node',
      VIEWPORT_CUSTOM_AGENT_ID: 'demo-agent',
      VIEWPORT_CUSTOM_AGENT_NAME: 'Demo agent',
      VIEWPORT_CUSTOM_AGENT_ARGS_JSON: '["-e","console.log(1)"]',
    });

    expect(definition).toMatchObject({
      id: 'demo-agent',
      displayName: 'Demo agent',
      tier: 'pty',
      capabilities: {
        structuredToolCalls: false,
        permissionCallbacks: false,
        resume: false,
      },
    });
    expect(await definition?.detection.check()).toBe(true);
    const adapter = await definition?.createAdapter();
    expect(adapter?.agentId).toBe('demo-agent');
  });

  it('rejects ambiguous custom agent ids and malformed args', () => {
    expect(() =>
      customCommandAgentFromEnv({
        VIEWPORT_CUSTOM_AGENT_COMMAND: 'node',
        VIEWPORT_CUSTOM_AGENT_ID: 'bad agent',
      }),
    ).toThrow('Invalid VIEWPORT_CUSTOM_AGENT_ID');

    expect(() =>
      customCommandAgentFromEnv({
        VIEWPORT_CUSTOM_AGENT_COMMAND: 'node',
        VIEWPORT_CUSTOM_AGENT_ARGS_JSON: '{"not":"an array"}',
      }),
    ).toThrow('JSON array of strings');
  });
});
