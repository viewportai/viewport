import { describe, expect, it } from 'vitest';
import {
  getHookAdapterCapabilities,
  hookAdapterSupports,
  listHookAdapterCapabilities,
} from '../../src/hooks/capabilities.js';

describe('hook adapter capability registry', () => {
  it('models provider plan boundaries explicitly', () => {
    expect(getHookAdapterCapabilities('claude-code')).toMatchObject({
      adapter: 'claude',
      planBoundary: 'pre_execution',
    });
    expect(getHookAdapterCapabilities('codex')).toMatchObject({
      adapter: 'codex',
      planBoundary: 'post_render',
    });
    expect(getHookAdapterCapabilities('opencode')).toMatchObject({
      adapter: 'opencode',
      planBoundary: 'tool_submit',
    });
  });

  it('does not claim uniform hook behavior across providers', () => {
    expect(hookAdapterSupports('claude', 'plan.pre_execution_blocking')).toBe(true);
    expect(hookAdapterSupports('codex', 'plan.pre_execution_blocking')).toBe(false);
    expect(hookAdapterSupports('codex', 'plan.post_render_revision')).toBe(true);
    expect(hookAdapterSupports('opencode', 'plan.agent_role_gating')).toBe(true);
  });

  it('falls back to explicit-only generic capability for unknown adapters', () => {
    const profile = getHookAdapterCapabilities('future-agent');

    expect(profile.adapter).toBe('generic');
    expect(hookAdapterSupports('future-agent', 'plan.explicit_payload')).toBe(true);
    expect(hookAdapterSupports('future-agent', 'permission.blocking')).toBe(false);
  });

  it('returns defensive copies', () => {
    const profiles = listHookAdapterCapabilities();
    profiles[0]?.capabilities.splice(0);

    expect(getHookAdapterCapabilities('claude').capabilities.length).toBeGreaterThan(0);
  });
});
