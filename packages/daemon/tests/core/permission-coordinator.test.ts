import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventEmitter } from '../../src/core/events.js';
import type { DaemonEvents } from '../../src/core/events.js';
import { PermissionCoordinator } from '../../src/core/permission-coordinator.js';

describe('PermissionCoordinator', () => {
  let eventBus: TypedEventEmitter<DaemonEvents>;
  let coordinator: PermissionCoordinator;

  const makeConfigBase = () => ({
    agent: 'claude' as const,
    gitTracker: {
      enabled: false,
      commitOn: [] as string[],
      ignore: [] as string[],
      autoSquashOnComplete: false,
      branchPrefix: 'viewport/',
      commitAuthor: 'Test <noreply@example.test>',
      maxCommitsPerSession: 100,
      worktreeRoot: '.viewport/worktrees',
    },
    permissions: {
      autoApprove: [] as string[],
      requireApproval: ['*'],
      deny: [] as string[],
    },
    trust: 'operator' as const,
  });

  const makeConfig = (overrides: Partial<ReturnType<typeof makeConfigBase>> = {}) => ({
    ...makeConfigBase(),
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new TypedEventEmitter<DaemonEvents>();
    // Use a short timeout for tests (100ms)
    coordinator = new PermissionCoordinator(eventBus, 100);
  });

  it('auto-denies after timeout', async () => {
    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const resultPromise = handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-1',
      },
    );

    // Advance past the timeout
    vi.advanceTimersByTime(150);

    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect(result).toHaveProperty('message');
    expect((result as { message: string }).message).toContain('timed out');
  });

  it('emits attention event with idle_timeout reason on timeout', async () => {
    const attentionHandler = vi.fn();
    eventBus.on('session:attention', attentionHandler);

    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const resultPromise = handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-2',
      },
    );

    vi.advanceTimersByTime(150);
    await resultPromise;

    expect(attentionHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        attention: expect.objectContaining({
          requiresAttention: true,
          reason: 'idle_timeout',
        }),
      }),
    );
  });

  it('clears timeout when permission is responded before timeout', async () => {
    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const resultPromise = handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-3',
      },
    );

    // Respond before timeout
    coordinator.respondPermission('session-1', 'tool-3', { behavior: 'allow' });

    const result = await resultPromise;
    expect(result.behavior).toBe('allow');

    // Advance past original timeout — should not cause issues
    vi.advanceTimersByTime(200);
  });

  it('clears timeout when abort signal fires', async () => {
    const attentionHandler = vi.fn();
    eventBus.on('session:attention', attentionHandler);

    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const resultPromise = handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-4',
      },
    );

    // Abort before timeout
    controller.abort();

    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toBe('Request cancelled');

    // Advance past timeout — attention should NOT have been emitted
    vi.advanceTimersByTime(200);
    expect(attentionHandler).not.toHaveBeenCalled();
  });

  it('rejectPendingPermissions clears timeout', async () => {
    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const resultPromise = handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-5',
      },
    );

    coordinator.rejectPendingPermissions('session-1');

    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toBe('Session ended');
  });

  it('lists pending permissions with metadata', async () => {
    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const resultPromise = handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-6',
        decisionReason: 'needs permission',
      },
    );

    const pending = coordinator.listPendingPermissions('session-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe('tool-6');
    expect(pending[0]?.toolName).toBe('Write');

    coordinator.respondPermission('session-1', 'tool-6', { behavior: 'allow' });
    await resultPromise;
    expect(coordinator.listPendingPermissions('session-1')).toHaveLength(0);
  });

  it('bypass mode auto-allows permission-gated tools', async () => {
    coordinator.setSessionMode('session-1', 'bypass');
    const handler = coordinator.createPermissionHandler('session-1', makeConfig());
    const controller = new AbortController();

    const result = await handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-7',
      },
    );

    expect(result.behavior).toBe('allow');
    expect(coordinator.listPendingPermissions('session-1')).toHaveLength(0);
  });

  it('automated approvalPolicy never auto-allows permission-gated tools', async () => {
    const handler = coordinator.createPermissionHandler(
      'session-1',
      makeConfig({ trust: 'automated', approvalPolicy: 'never' }),
    );
    const requested = vi.fn();
    eventBus.on('permission:requested', requested);
    const controller = new AbortController();

    const result = await handler(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: controller.signal,
        toolUseId: 'tool-8',
      },
    );

    expect(result.behavior).toBe('allow');
    expect(requested).not.toHaveBeenCalled();
    expect(coordinator.listPendingPermissions('session-1')).toHaveLength(0);
  });

  it('addAutoApprove returns updated config without mutating input', () => {
    const config = makeConfig();
    const updated = coordinator.addAutoApprove(config, 'Edit');

    expect(updated).not.toBe(config);
    expect(config.permissions.autoApprove).toEqual([]);
    expect(updated.permissions.autoApprove).toEqual(['Edit']);
  });
});
