import { afterEach, describe, expect, it } from 'vitest';

import { cleanChildProcessEnv } from '../../src/security/child-env.js';

describe('child process environment', () => {
  const originalOpenAi = process.env['OPENAI_API_KEY'];
  const originalAnthropic = process.env['ANTHROPIC_API_KEY'];
  const originalToken = process.env['GITHUB_TOKEN'];

  afterEach(() => {
    restore('OPENAI_API_KEY', originalOpenAi);
    restore('ANTHROPIC_API_KEY', originalAnthropic);
    restore('GITHUB_TOKEN', originalToken);
  });

  it('scrubs ambient provider secrets unless explicitly selected for the child', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai-runner-secret';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-runner-secret';
    process.env['GITHUB_TOKEN'] = 'ghs-runner-secret';

    const env = cleanChildProcessEnv({
      VIEWPORT_CREDENTIAL_REPO_GITHUB_EXAMPLE: 'ghs-run-scoped',
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.VIEWPORT_CREDENTIAL_REPO_GITHUB_EXAMPLE).toBe('ghs-run-scoped');
    expect(env.PATH).toBe(process.env.PATH);
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
