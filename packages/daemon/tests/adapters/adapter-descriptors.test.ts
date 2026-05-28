import { describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claude.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { GeminiCliAdapter } from '../../src/adapters/gemini-cli.js';
import { PtyAdapter } from '../../src/adapters/pty.js';
import type { AgentAdapter, AgentAdapterDescriptor } from '../../src/core/interfaces.js';

function expectValidDescriptor(adapter: AgentAdapter): AgentAdapterDescriptor {
  const descriptor = adapter.describe();
  expect(descriptor.schema).toBe('viewport.agent_adapter/v2');
  expect(descriptor.agentId).toBe(adapter.agentId);
  expect(descriptor.adapterVersion.length).toBeGreaterThan(0);
  expect(Object.keys(descriptor.capabilities.executionModes).sort()).toEqual([
    'implement',
    'plan',
    'read_only',
    'review',
  ]);
  expect(descriptor.capabilities.hardTimeout).not.toBe('unsupported');
  return descriptor;
}

describe('agent adapter descriptors', () => {
  it('declares Claude as provider-enforced for planning, read-only work, tools, and usage', () => {
    const adapter = new ClaudeAdapter(
      vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {},
        interrupt: vi.fn(),
        close: vi.fn(),
      }),
    );

    const descriptor = expectValidDescriptor(adapter);
    expect(descriptor.capabilities.executionModes.plan).toBe('provider');
    expect(descriptor.capabilities.executionModes.read_only).toBe('provider');
    expect(descriptor.capabilities.toolAllowlist).toBe('provider');
    expect(descriptor.capabilities.usageReporting).toBe('reported');
    expect(descriptor.capabilities.costReporting).toBe('reported');
  });

  it('declares Codex plan/read-only enforcement as unsupported until the adapter maps it explicitly', () => {
    const adapter = new CodexAdapter(vi.fn());

    const descriptor = expectValidDescriptor(adapter);
    expect(descriptor.capabilities.executionModes.plan).toBe('unsupported');
    expect(descriptor.capabilities.executionModes.read_only).toBe('unsupported');
    expect(descriptor.capabilities.toolAllowlist).toBe('unsupported');
    expect(descriptor.capabilities.usageReporting).toBe('reported');
  });

  it('declares custom command adapters as degraded and non-accounting by default', () => {
    const descriptor = expectValidDescriptor(new PtyAdapter('custom', 'custom-agent'));

    expect(descriptor.capabilities.executionModes.plan).toBe('prompt_only');
    expect(descriptor.capabilities.toolAllowlist).toBe('unsupported');
    expect(descriptor.capabilities.usageReporting).toBe('unavailable');
    expect(descriptor.capabilities.costReporting).toBe('unavailable');
  });

  it('declares Gemini CLI as prompt-only until a hard enforcement adapter exists', () => {
    const descriptor = expectValidDescriptor(new GeminiCliAdapter());

    expect(descriptor.capabilities.executionModes.plan).toBe('prompt_only');
    expect(descriptor.capabilities.executionModes.read_only).toBe('unsupported');
    expect(descriptor.capabilities.toolAllowlist).toBe('unsupported');
  });
});
