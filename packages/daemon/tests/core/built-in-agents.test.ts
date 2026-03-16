import { describe, expect, it } from 'vitest';
import { BUILT_IN_AGENTS } from '../../src/agents/built-in.js';

describe('built-in agents', () => {
  it('includes only claude, codex, and gemini', () => {
    const ids = BUILT_IN_AGENTS.map((agent) => agent.id).sort();
    expect(ids).toEqual(['claude', 'codex', 'gemini']);
  });
});
