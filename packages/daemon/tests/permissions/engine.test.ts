import { describe, it, expect } from 'vitest';
import { resolvePermission, matchesTool } from '../../src/permissions/engine.js';
import type { PermissionsConfig } from '../../src/core/types.js';

const DEFAULT_CONFIG: PermissionsConfig = {
  autoApprove: ['Read', 'Glob', 'Grep'],
  requireApproval: ['Edit', 'Write', 'Bash'],
  deny: ['DeleteAll'],
};

describe('resolvePermission', () => {
  it('auto-approves tools in autoApprove list', () => {
    expect(resolvePermission('Read', undefined, DEFAULT_CONFIG)).toBe('auto-approve');
    expect(resolvePermission('Glob', undefined, DEFAULT_CONFIG)).toBe('auto-approve');
    expect(resolvePermission('Grep', undefined, DEFAULT_CONFIG)).toBe('auto-approve');
  });

  it('requires approval for tools in requireApproval list', () => {
    expect(resolvePermission('Edit', undefined, DEFAULT_CONFIG)).toBe('require-approval');
    expect(resolvePermission('Write', undefined, DEFAULT_CONFIG)).toBe('require-approval');
    expect(resolvePermission('Bash', undefined, DEFAULT_CONFIG)).toBe('require-approval');
  });

  it('denies tools in deny list', () => {
    expect(resolvePermission('DeleteAll', undefined, DEFAULT_CONFIG)).toBe('deny');
  });

  it('deny takes priority over autoApprove', () => {
    const config: PermissionsConfig = {
      autoApprove: ['Bash'],
      requireApproval: [],
      deny: ['Bash'],
    };
    expect(resolvePermission('Bash', undefined, config)).toBe('deny');
  });

  it('deny takes priority over requireApproval', () => {
    const config: PermissionsConfig = {
      autoApprove: [],
      requireApproval: ['Bash'],
      deny: ['Bash'],
    };
    expect(resolvePermission('Bash', undefined, config)).toBe('deny');
  });

  it('autoApprove takes priority over requireApproval', () => {
    const config: PermissionsConfig = {
      autoApprove: ['Edit'],
      requireApproval: ['Edit'],
      deny: [],
    };
    expect(resolvePermission('Edit', undefined, config)).toBe('auto-approve');
  });

  it('unknown tools default to require-approval', () => {
    expect(resolvePermission('UnknownTool', undefined, DEFAULT_CONFIG)).toBe('require-approval');
    expect(resolvePermission('CustomMcpTool', undefined, DEFAULT_CONFIG)).toBe('require-approval');
  });

  it('handles empty config', () => {
    const config: PermissionsConfig = {
      autoApprove: [],
      requireApproval: [],
      deny: [],
    };
    expect(resolvePermission('Read', undefined, config)).toBe('require-approval');
  });

  it('ignores tool input for now (v0.1)', () => {
    // Tool input is passed but not used in v0.1 — it's there for future
    // semantic matching (e.g. Bash commands)
    const input = { command: 'rm -rf /' };
    expect(resolvePermission('Read', input, DEFAULT_CONFIG)).toBe('auto-approve');
  });
});

describe('matchesTool', () => {
  it('matches exact tool names', () => {
    expect(matchesTool('Read', ['Read', 'Edit'])).toBe(true);
    expect(matchesTool('Edit', ['Read', 'Edit'])).toBe(true);
  });

  it('returns false for non-matching tools', () => {
    expect(matchesTool('Write', ['Read', 'Edit'])).toBe(false);
  });

  it('handles empty patterns list', () => {
    expect(matchesTool('Read', [])).toBe(false);
  });
});
