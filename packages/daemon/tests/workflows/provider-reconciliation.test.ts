import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  githubReconciliationRequest,
  reconcileProviderAction,
} from '../../src/workflows/provider-reconciliation.js';

const originalFetch = global.fetch;

describe('provider reconciliation', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('verifies a provider read-after-write identity match', async () => {
    const initial = {
      number: 4821,
      html_url: 'https://github.com/acme/payments/pull/4821',
      url: 'https://api.github.com/repos/acme/payments/pulls/4821',
    };
    global.fetch = vi.fn(async () => new Response(JSON.stringify(initial), { status: 200 }));

    const request = githubReconciliationRequest(
      { Authorization: 'Bearer runner-token' },
      initial,
      'pull_request',
    );

    await expect(reconcileProviderAction(request, undefined, initial)).resolves.toMatchObject({
      status: 'verified',
      method: 'read_after_write',
      checkedBy: 'vpd.provider_adapter',
      providerReference: 'https://github.com/acme/payments/pull/4821',
      providerUrl: 'https://github.com/acme/payments/pull/4821',
      targetDigest: expect.stringMatching(/^sha256:/),
      payloadDigest: expect.stringMatching(/^sha256:/),
      payload: {
        provider: 'github',
        kind: 'pull_request',
        apiUrl: 'https://api.github.com/repos/acme/payments/pulls/4821',
        htmlUrl: 'https://github.com/acme/payments/pull/4821',
        number: 4821,
      },
    });
  });

  it('flags a provider read-after-write identity mismatch', async () => {
    const initial = {
      number: 4821,
      html_url: 'https://github.com/acme/payments/pull/4821',
      url: 'https://api.github.com/repos/acme/payments/pulls/4821',
    };
    const readBack = {
      number: 4822,
      html_url: 'https://github.com/acme/payments/pull/4822',
      url: 'https://api.github.com/repos/acme/payments/pulls/4822',
    };
    global.fetch = vi.fn(async () => new Response(JSON.stringify(readBack), { status: 200 }));

    const request = githubReconciliationRequest(
      { Authorization: 'Bearer runner-token' },
      initial,
      'pull_request',
    );

    await expect(reconcileProviderAction(request, undefined, initial)).resolves.toMatchObject({
      status: 'mismatch',
      method: 'read_after_write',
      providerReference: 'https://github.com/acme/payments/pull/4821',
      providerUrl: 'https://github.com/acme/payments/pull/4822',
      payload: {
        expected: expect.objectContaining({
          htmlUrl: 'https://github.com/acme/payments/pull/4821',
          number: 4821,
        }),
        actual: expect.objectContaining({
          htmlUrl: 'https://github.com/acme/payments/pull/4822',
          number: 4822,
        }),
      },
    });
  });

  it('records unavailable and unsupported reconciliation explicitly', async () => {
    const initial = {
      number: 4821,
      html_url: 'https://github.com/acme/payments/pull/4821',
      url: 'https://api.github.com/repos/acme/payments/pulls/4821',
    };
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 }));

    const request = githubReconciliationRequest(
      { Authorization: 'Bearer runner-token' },
      initial,
      'pull_request',
    );

    await expect(reconcileProviderAction(request, undefined, initial)).resolves.toMatchObject({
      status: 'unavailable',
      method: 'read_after_write',
      error: 'HTTP 404: not found',
    });

    await expect(
      reconcileProviderAction(
        null,
        'Provider does not expose a stable read-back endpoint.',
        initial,
      ),
    ).resolves.toMatchObject({
      status: 'not_checked',
      method: 'not_supported',
      checkedBy: 'vpd.provider_adapter',
      payload: { reason: 'Provider does not expose a stable read-back endpoint.' },
    });
  });
});
