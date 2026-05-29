import { describe, expect, it } from 'vitest';
import { envNameForCredentialRef } from '../../src/workflows/action-provider-utils.js';

describe('action provider credential env names', () => {
  it('keeps simple credential refs readable', () => {
    expect(envNameForCredentialRef('github_pr_writer')).toBe(
      'VIEWPORT_CREDENTIAL_GITHUB_PR_WRITER',
    );
  });

  it('uses digest based names for structured refs to avoid normalization collisions', () => {
    const structuredRef = envNameForCredentialRef('repo/github/payments-api');
    const normalizedLookalike = envNameForCredentialRef('repo_github_payments_api');

    expect(structuredRef).toMatch(/^VIEWPORT_CREDENTIAL_REF_[A-F0-9]{24}$/);
    expect(normalizedLookalike).toBe('VIEWPORT_CREDENTIAL_REPO_GITHUB_PAYMENTS_API');
    expect(structuredRef).not.toBe(normalizedLookalike);
  });
});
