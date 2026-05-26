import { describe, expect, it } from 'vitest';
import { sanitizeContextQueryForReceipt } from '../../src/workflows/context-node-resolver.js';

describe('context node resolver receipts', () => {
  it('redacts Slack and provider secrets from stored context query receipts', () => {
    const query =
      'Slack event: {"token":"slack_verification_secret","event":{"text":"hello"},"access_token":"xoxb-real-token"} ' +
      "headers: {'api_key':'sk-openai-secret'} git=ghs_github_secret runner=vprunner_secret";

    const redacted = sanitizeContextQueryForReceipt(query);

    expect(redacted).toContain('"token":"[redacted]"');
    expect(redacted).toContain('"access_token":"[redacted]"');
    expect(redacted).toContain("'api_key':'[redacted]'");
    expect(redacted).not.toContain('slack_verification_secret');
    expect(redacted).not.toContain('xoxb-real-token');
    expect(redacted).not.toContain('sk-openai-secret');
    expect(redacted).not.toContain('ghs_github_secret');
    expect(redacted).not.toContain('vprunner_secret');
  });
});
