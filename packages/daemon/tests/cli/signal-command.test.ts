import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('signal CLI command', () => {
  const originalArgv = process.argv.slice();
  const originalFetch = global.fetch;
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.resetModules();
    logSpy.mockClear();
    process.argv = originalArgv.slice();
    if (originalViewportHome === undefined) {
      delete process.env['VIEWPORT_HOME'];
    } else {
      process.env['VIEWPORT_HOME'] = originalViewportHome;
    }
    global.fetch = originalFetch;
  });

  afterEach(() => {
    process.argv = originalArgv.slice();
    if (originalViewportHome === undefined) {
      delete process.env['VIEWPORT_HOME'];
    } else {
      process.env['VIEWPORT_HOME'] = originalViewportHome;
    }
    global.fetch = originalFetch;
  });

  it('extracts bounded tenant-side signal features without storing raw text', async () => {
    process.argv = [
      'node',
      'vpd',
      'signal',
      'features',
      '--repo',
      'Acme/Payments-API',
      '--changed-path',
      'src/payments/retry.ts',
      '--changed-path',
      '../secret.txt',
      '--label',
      'Incident!',
      '--text',
      'Raw customer message about checkout retry failure should stay local.',
      '--json',
    ];

    const { signal } = await import('../../src/cli/signal-command.js');
    await signal();

    const output = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(output.command).toBe('signal features');
    expect(output.projected).toBe(false);
    expect(output.extraction).toMatchObject({
      source: 'tenant_side_signal_extractor',
      raw_message_content_used_locally: true,
      raw_message_content_posted: false,
      raw_message_content_stored_in_output: false,
      privacy_preserving_features_only: true,
      learned_state_expands_access: false,
      authorization_remains_separate: true,
    });
    expect(output.signal_features).toMatchObject({
      repository: 'acme/payments-api',
      changed_paths: ['src/payments/retry.ts'],
      labels: ['incident'],
    });
    expect(output.signal_features.text_tokens).toEqual(
      expect.arrayContaining(['raw', 'customer', 'checkout', 'retry', 'failure', 'local']),
    );
    expect(JSON.stringify(output)).not.toContain('Raw customer message');
    expect(JSON.stringify(output)).not.toContain('../secret');
  });

  it('projects bounded features to the runtime API and never posts raw text', async () => {
    process.argv = [
      'node',
      'vpd',
      'signal',
      'features',
      '--repo',
      'acme/payments-api',
      '--changed-path',
      'src/payments/retry.ts',
      '--label',
      'incident',
      '--text',
      'Sensitive incident narrative remains tenant-side.',
      '--provider',
      'slack',
      '--event-type',
      'message.created',
      '--workspace',
      'workspace_alpha',
      '--server-url',
      'http://api.getviewport.test',
      '--credential',
      'issue_token_alpha',
      '--project',
      '--json',
    ];

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        data: {
          schema: 'viewport.signal_feature_envelope/v1',
          workspace_id: 'workspace_alpha',
          runtime_target_id: 'runtime_alpha',
          feature_digest: 'sha256:projected-features',
          features: {
            repository: 'acme/payments-api',
            changed_paths: ['src/payments/retry.ts'],
            labels: ['incident'],
            text_tokens: ['sensitive', 'incident', 'narrative', 'remains', 'tenant-side'],
          },
          feature_extraction: {
            source: 'trusted_edge_signal_features',
            raw_message_content_used_for_ranking: false,
            raw_message_content_stored_in_candidate: false,
            privacy_preserving_features_only: true,
            authorization_remains_separate: true,
          },
        },
      });
    }) as typeof fetch;

    const { signal } = await import('../../src/cli/signal-command.js');
    await signal();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'http://api.getviewport.test/api/runtime/workspaces/workspace_alpha/signal-features/project',
    );
    expect(requests[0]?.body).toMatchObject({
      credential: 'issue_token_alpha',
      target_workspace_id: 'workspace_alpha',
      provider: 'slack',
      event_type: 'message.created',
      signal_features: {
        repository: 'acme/payments-api',
        changed_paths: ['src/payments/retry.ts'],
        labels: ['incident'],
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('Sensitive incident narrative');
    expect(JSON.stringify(requests[0]?.body)).not.toContain('raw_text');

    const output = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(output.command).toBe('signal features');
    expect(output.projected).toBe(true);
    expect(output.platform.data.feature_digest).toBe('sha256:projected-features');
    expect(JSON.stringify(output)).not.toContain('Sensitive incident narrative');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
