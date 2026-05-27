import { describe, expect, it } from 'vitest';
import { createSessionOutputCollector } from '../../src/workflows/session-output.js';
import type { AgentAdapterDescriptor } from '../../src/core/interfaces.js';

const adapter: AgentAdapterDescriptor = {
  schema: 'viewport.agent_adapter/v2',
  agentId: 'claude',
  displayName: 'Claude',
  adapterVersion: 'test',
  capabilities: {
    executionModes: {
      plan: 'provider',
      read_only: 'provider',
      review: 'provider',
      implement: 'provider',
    },
    toolAllowlist: 'provider',
    structuredOutput: 'prompt_only',
    permissionHooks: 'provider',
    usageReporting: 'reported',
    costReporting: 'reported',
    maxTurns: 'provider',
    maxBudget: 'provider',
    hardTimeout: 'hard',
  },
};

describe('session output collector', () => {
  it('collects final text, usage, tool calls, and enforcement into an agent run result', () => {
    const collector = createSessionOutputCollector();

    collector.push({
      type: 'agent_message_chunk',
      messageId: 'message-1',
      text: 'hel',
      timestamp: 100,
    });
    collector.push({
      type: 'agent_message_chunk',
      messageId: 'message-1',
      text: 'lo',
      timestamp: 101,
    });
    collector.push({
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'Read',
      title: 'Read file',
      input: { file_path: 'README.md' },
      status: 'in_progress',
      timestamp: 102,
    });
    collector.push({
      type: 'tool_call_update',
      toolCallId: 'tool-1',
      toolName: 'Read',
      status: 'completed',
      output: 'ok',
      timestamp: 103,
    });
    collector.push({
      type: 'token_usage',
      inputTokens: 12,
      outputTokens: 5,
      totalCostUsd: 0.002,
      modelUsage: {
        'claude-test': { inputTokens: 12, outputTokens: 5, costUsd: 0.002 },
      },
      durationMs: 250,
      numTurns: 1,
      timestamp: 104,
    });

    const result = collector.agentRunResult({
      agent: adapter,
      model: 'claude-test',
      executionMode: 'read_only',
      startedAt: 100,
      completedAt: 400,
      reason: 'idle',
    });

    expect(result.output).toBe('hello');
    expect(result.stopReason).toBe('idle');
    expect(result.executionMode).toBe('read_only');
    expect(result.usage).toMatchObject({
      available: true,
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      totalCostUsd: 0.002,
      durationMs: 250,
      numTurns: 1,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'tool-1',
      name: 'Read',
      status: 'completed',
      title: 'Read file',
    });
    expect(result.toolCalls[0]?.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.enforcement).toMatchObject({
      executionMode: 'read_only',
      readOnlyMode: 'provider',
      toolAllowlist: 'provider',
    });
  });

  it('marks usage unavailable when the adapter emits no usage', () => {
    const collector = createSessionOutputCollector();
    collector.push({
      type: 'agent_message',
      messageId: 'message-1',
      text: 'done',
      timestamp: 100,
    });

    const result = collector.agentRunResult({
      agent: { ...adapter, capabilities: { ...adapter.capabilities, usageReporting: 'unavailable' } },
      executionMode: 'plan',
      startedAt: 100,
      completedAt: 120,
      reason: 'completed',
    });

    expect(result.output).toBe('done');
    expect(result.usage).toEqual({
      available: false,
      reason: 'adapter_no_usage',
    });
  });
});
