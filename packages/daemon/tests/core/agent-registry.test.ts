import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import type { AgentDefinition, AgentCapabilities } from '../../src/core/agent-registry.js';
import { claudeAgent } from '../../src/agents/claude.js';
import { codexAgent } from '../../src/agents/codex.js';
import { geminiAgent } from '../../src/agents/gemini.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'test-agent',
    displayName: 'Test Agent',
    tier: 'pty',
    defaults: {
      commitOn: ['write'],
      autoApprove: ['read'],
      requireApproval: ['write'],
      deny: ['delete'],
    },
    capabilities: {
      structuredToolCalls: false,
      permissionCallbacks: false,
      tokenUsage: false,
      resume: false,
      extendedThinking: false,
    },
    detection: {
      check: async () => true,
      description: 'Test agent for testing',
    },
    createAdapter: async () => null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

describe('AgentRegistry', () => {
  it('registers and retrieves agent definitions', () => {
    const registry = new AgentRegistry();
    const agent = createTestAgent();
    registry.register(agent);

    expect(registry.get('test-agent')).toBe(agent);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered agents', () => {
    const registry = new AgentRegistry();
    registry.register(createTestAgent({ id: 'agent-a', displayName: 'Agent A' }));
    registry.register(createTestAgent({ id: 'agent-b', displayName: 'Agent B' }));

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.id)).toEqual(['agent-a', 'agent-b']);
  });

  it('returns agent IDs', () => {
    const registry = new AgentRegistry();
    registry.register(createTestAgent({ id: 'claude' }));
    registry.register(createTestAgent({ id: 'aider' }));

    expect(registry.getIds()).toEqual(['claude', 'aider']);
  });

  it('detects available agents', async () => {
    const registry = new AgentRegistry();
    registry.register(
      createTestAgent({
        id: 'available',
        detection: { check: async () => true, description: 'always available' },
      }),
    );
    registry.register(
      createTestAgent({
        id: 'unavailable',
        detection: { check: async () => false, description: 'never available' },
      }),
    );

    const results = await registry.detectAvailable();
    expect(results.get('available')).toBe(true);
    expect(results.get('unavailable')).toBe(false);
  });

  it('handles detection errors gracefully', async () => {
    const registry = new AgentRegistry();
    registry.register(
      createTestAgent({
        id: 'broken',
        detection: {
          check: async () => {
            throw new Error('detection failed');
          },
          description: 'broken detection',
        },
      }),
    );

    const results = await registry.detectAvailable();
    expect(results.get('broken')).toBe(false);
  });

  it('resolves agent permissions defaults', () => {
    const registry = new AgentRegistry();
    registry.register(createTestAgent());

    const perms = registry.resolveAgentPermissions('test-agent');
    expect(perms).toEqual({
      autoApprove: ['read'],
      requireApproval: ['write'],
      deny: ['delete'],
    });
  });

  it('returns undefined for unknown agent permissions', () => {
    const registry = new AgentRegistry();
    expect(registry.resolveAgentPermissions('unknown')).toBeUndefined();
  });

  it('resolves agent git config', () => {
    const registry = new AgentRegistry();
    registry.register(createTestAgent());

    const gitConfig = registry.resolveAgentGitConfig('test-agent');
    expect(gitConfig).toEqual({ commitOn: ['write'] });
  });

  it('returns capabilities for an agent', () => {
    const registry = new AgentRegistry();
    const caps: AgentCapabilities = {
      structuredToolCalls: true,
      permissionCallbacks: true,
      tokenUsage: true,
      resume: false,
      extendedThinking: false,
    };
    registry.register(createTestAgent({ capabilities: caps }));

    expect(registry.getCapabilities('test-agent')).toEqual(caps);
    expect(registry.getCapabilities('unknown')).toBeUndefined();
  });

  it('collects watch dirs from all agents', () => {
    const registry = new AgentRegistry();
    registry.register(
      createTestAgent({
        id: 'agent-a',
        watchDirs: () => ['/home/user/.agent-a/projects'],
      }),
    );
    registry.register(
      createTestAgent({
        id: 'agent-b',
        watchDirs: () => ['/home/user/.agent-b/sessions'],
      }),
    );
    registry.register(createTestAgent({ id: 'agent-c' })); // no watchDirs

    const dirs = registry.getAllWatchDirs();
    expect(dirs).toEqual(['/home/user/.agent-a/projects', '/home/user/.agent-b/sessions']);
  });

  it('serializes to hello payload', () => {
    const registry = new AgentRegistry();
    registry.register(createTestAgent({ id: 'claude', displayName: 'Claude Code', tier: 'sdk' }));
    registry.register(createTestAgent({ id: 'aider', displayName: 'Aider', tier: 'pty' }));

    const payload = registry.toHelloPayload();
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      id: 'claude',
      displayName: 'Claude Code',
      tier: 'sdk',
      available: true,
    });
    expect(payload[1]).toMatchObject({
      id: 'aider',
      displayName: 'Aider',
      tier: 'pty',
      available: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Claude agent definition
// ---------------------------------------------------------------------------

describe('claudeAgent definition', () => {
  it('has correct id and tier', () => {
    expect(claudeAgent.id).toBe('claude');
    expect(claudeAgent.tier).toBe('sdk');
    expect(claudeAgent.displayName).toBe('Claude Code');
  });

  it('has Claude-specific tool defaults', () => {
    expect(claudeAgent.defaults.commitOn).toContain('Edit');
    expect(claudeAgent.defaults.commitOn).toContain('Write');
    expect(claudeAgent.defaults.commitOn).toContain('Bash');
    expect(claudeAgent.defaults.autoApprove).toContain('Read');
    expect(claudeAgent.defaults.autoApprove).toContain('Glob');
    expect(claudeAgent.defaults.autoApprove).toContain('Grep');
    expect(claudeAgent.defaults.requireApproval).toContain('Edit');
    expect(claudeAgent.defaults.deny).toEqual([]);
  });

  it('declares SDK capabilities', () => {
    expect(claudeAgent.capabilities.structuredToolCalls).toBe(true);
    expect(claudeAgent.capabilities.permissionCallbacks).toBe(true);
    expect(claudeAgent.capabilities.tokenUsage).toBe(true);
    expect(claudeAgent.capabilities.resume).toBe(true);
    expect(claudeAgent.capabilities.extendedThinking).toBe(true);
  });

  it('provides watch dirs', () => {
    const dirs = claudeAgent.watchDirs!();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/\.claude\/projects$/);
  });

  it('has discovery factory', () => {
    expect(claudeAgent.createDiscovery).toBeDefined();
  });
});

describe('additional built-in agent definitions', () => {
  it('codex agent is an SDK adapter definition', () => {
    expect(codexAgent.id).toBe('codex');
    expect(codexAgent.tier).toBe('sdk');
    expect(codexAgent.capabilities.structuredToolCalls).toBe(true);
    expect(codexAgent.capabilities.permissionCallbacks).toBe(false);
    expect(codexAgent.capabilities.tokenUsage).toBe(true);
    expect(codexAgent.capabilities.resume).toBe(true);
  });

  it('gemini agent is a CLI-backed adapter definition with resume capability', () => {
    expect(geminiAgent.id).toBe('gemini');
    expect(geminiAgent.tier).toBe('sdk');
    expect(geminiAgent.capabilities.resume).toBe(true);
  });
});
