import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger as output } from '../../src/core/output.js';
import { redactSecrets, redactSecretsFromString } from '../../src/core/redaction.js';

describe('daemon output redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts secret-like values from CLI output strings', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    output.log(
      'claim failed',
      'Authorization: Bearer ghs_cli_output_should_not_print',
      'token=vpclaim_cli_output_should_not_print',
    );

    const printed = log.mock.calls.flat().join(' ');
    expect(printed).toContain('[redacted]');
    expect(printed).not.toContain('ghs_cli_output_should_not_print');
    expect(printed).not.toContain('vpclaim_cli_output_should_not_print');
  });

  it('redacts sensitive object keys while preserving token counters', () => {
    const redacted = redactSecrets({
      authorization: 'Bearer ghs_object_auth_should_not_print',
      nested: {
        lease_token: 'vpclaim_object_lease_should_not_print',
        total_tokens: 7329,
        outputTokens: 250,
        safe: 'kept',
      },
    });

    expect(redacted).toEqual({
      authorization: '[redacted]',
      nested: {
        lease_token: '[redacted]',
        total_tokens: 7329,
        outputTokens: 250,
        safe: 'kept',
      },
    });
  });

  it('redacts common provider tokens embedded in free-form debug strings', () => {
    const text = redactSecretsFromString(
      'github=ghs_debug_output_should_not_print slack=xoxb-debug-output-secret openai=sk-ant-debug-output-secret',
    );

    expect(text).toBe('github=[redacted] slack=[redacted] openai=[redacted]');
  });
});
