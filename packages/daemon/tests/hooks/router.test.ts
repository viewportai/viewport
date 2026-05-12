import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HookRouter, safeHookLogInput } from '../../src/hooks/router.js';
import { SupervisionManager } from '../../src/hooks/supervision.js';
import { TypedEventEmitter } from '../../src/core/events.js';
import type { DaemonEvents } from '../../src/core/events.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';
import { workflowHookRegistry } from '../../src/workflows/hook-registry.js';
import { PLAN_PROPOSAL_SCHEMA_VERSION } from '../../src/hooks/plan-extractor.js';

function mockClient(): ConnectedClient {
  return {
    send: () => {},
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
}

describe('HookRouter', () => {
  let eventBus: TypedEventEmitter<DaemonEvents>;
  let supervision: SupervisionManager;
  let router: HookRouter;

  beforeEach(() => {
    workflowHookRegistry.clear();
    eventBus = new TypedEventEmitter<DaemonEvents>();
    supervision = new SupervisionManager();
    router = new HookRouter(eventBus, supervision);
  });

  // -------------------------------------------------------------------------
  // Non-blocking events
  // -------------------------------------------------------------------------

  it('handles SessionStart — emits event and returns non-passthrough', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:session-start', (data) => events.push(data));

    const result = await router.handleEvent({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      cwd: '/tmp/project',
      source: 'startup',
      agent_type: 'claude',
      model: 'sonnet-4',
    });

    expect(result.passthrough).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/tmp/project',
      source: 'startup',
    });
  });

  it('injects Claude session guidance when a repo has Viewport context configured', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hook-context-repo-'));
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      ['version: 1', 'resources:', '  contexts:', '    - ctx-team', ''].join('\n'),
      'utf8',
    );

    const result = await router.handleEvent({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      cwd: repo,
      source: 'startup',
    });

    expect(result.passthrough).toBe(false);
    expect(result.hookSpecificOutput).toMatchObject({
      hookEventName: 'SessionStart',
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      'Viewport context is configured for this repo.',
    );
    expect(result.suppressOutput).toBe(true);

    await fs.rm(repo, { recursive: true, force: true });
  });

  it('injects resolved approved context into UserPromptSubmit hook output', async () => {
    const previousHome = process.env['HOME'];
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hook-context-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-hook-context-repo-'));
    process.env['HOME'] = home;

    try {
      await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
      await fs.writeFile(
        path.join(repo, '.viewport', 'config.json'),
        JSON.stringify({ version: 1, resources: { contexts: ['ctx-auth'] } }),
        'utf8',
      );

      const { initContextResource, addContextEntry } =
        await import('../../src/context/local-edge-store.js');
      const credentials = { passphrase: 'alice-passphrase', recoveryCode: 'alice-recovery' };
      await initContextResource({
        contextResourceId: 'ctx-auth',
        userName: 'alice',
        deviceName: 'alice-laptop',
        credentials,
        home: path.join(home, '.viewport'),
      });
      await addContextEntry({
        contextResourceId: 'ctx-auth',
        actorName: 'alice-laptop',
        title: 'Auth rule',
        body: 'Dashboard auth changes require session rotation tests.',
        credentials,
        home: path.join(home, '.viewport'),
      });

      const result = await router.handleEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: 's1',
        cwd: repo,
        prompt: 'Change dashboard auth middleware.',
      });

      expect(result.passthrough).toBe(false);
      expect(result.hookSpecificOutput).toMatchObject({
        hookEventName: 'UserPromptSubmit',
      });
      expect(result.hookSpecificOutput?.additionalContext).toContain('<viewport_context>');
      expect(result.hookSpecificOutput?.additionalContext).toContain('### Auth rule');
      expect(result.hookSpecificOutput?.additionalContext).toContain(
        'Dashboard auth changes require session rotation tests.',
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = previousHome;
      }
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('handles SessionEnd — emits hook:session-end', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:session-end', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'SessionEnd',
      session_id: 's1',
      reason: 'prompt_input_exit',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 's1', reason: 'prompt_input_exit' });
  });

  it('handles Notification — emits hook:notification', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:notification', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      message: 'Task complete',
      title: 'Done',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 's1', message: 'Task complete', title: 'Done' });
  });

  it('handles PostToolUse — emits hook:tool-completed', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:tool-completed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'file.txt',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: 'Bash' });
  });

  it('extracts Claude plan mode drafts from ExitPlanMode PreToolUse hooks', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    const result = await router.handleEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/tmp/project',
      tool_name: 'ExitPlanMode',
      tool_input: {
        plan: '## Migrate auth\n\n1. Inspect routes\n2. Add tests',
        planFilePath: '/tmp/claude/plan.md',
        allowedPrompts: [],
      },
    });

    expect(result).toEqual({ passthrough: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/tmp/project',
      title: 'Migrate auth',
      body: '## Migrate auth\n\n1. Inspect routes\n2. Add tests',
      source: 'claude-exit-plan-mode',
      sourceRef: 'hook://exit-plan-mode/s1',
      metadata: {
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        extractedFrom: 'exit-plan-mode',
        planFilePath: '/tmp/claude/plan.md',
      },
    });
  });

  it('holds Claude ExitPlanMode PermissionRequest hooks and opens a plan draft even without supervision', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    const resultPromise = router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      cwd: '/tmp/project',
      tool_name: 'ExitPlanMode',
      tool_input: {
        plan: '## Migrate auth\n\n1. Inspect routes\n2. Add tests',
        planFilePath: '/tmp/claude/plan.md',
        allowedPrompts: [],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/tmp/project',
      title: 'Migrate auth',
      body: '## Migrate auth\n\n1. Inspect routes\n2. Add tests',
      source: 'claude-exit-plan-mode',
      metadata: {
        extractedFrom: 'exit-plan-mode',
        hookRequestId: expect.stringMatching(/^hk-/),
      },
    });

    const hookRequestId = (
      (events[0] as Record<string, unknown>).metadata as Record<string, unknown>
    ).hookRequestId as string;
    expect(router.getPendingPermissions().has(hookRequestId)).toBe(true);

    eventBus.emit('hook:permission-response', {
      hookRequestId,
      decision: { behavior: 'allow' },
    });

    await expect(resultPromise).resolves.toEqual({
      passthrough: false,
      decision: { behavior: 'allow' },
    });
  });

  it('ignores non-plan PreToolUse hooks for plan draft extraction', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(events).toHaveLength(0);
  });

  it('handles PostToolUseFailure — emits hook:tool-failed', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:tool-failed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'PostToolUseFailure',
      session_id: 's1',
      tool_name: 'Bash',
      error: 'command not found',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: 'Bash', error: 'command not found' });
  });

  it('handles Stop — emits hook:stop', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:stop', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      last_assistant_message: 'All done',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ lastMessage: 'All done' });
  });

  it('extracts explicit viewport-plan blocks from Stop hooks', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      cwd: '/tmp/project',
      last_assistant_message: [
        'Drafted the requested plan.',
        '```viewport-plan',
        `schema: ${PLAN_PROPOSAL_SCHEMA_VERSION}`,
        'title: Refactor auth callbacks',
        'summary: Move callback handling behind one service.',
        'source: claude-code',
        'source_ref: claude://session/s1',
        '---',
        '## Plan',
        '1. Extract callback service.',
        '2. Add regression tests.',
        '```',
      ].join('\n'),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/tmp/project',
      title: 'Refactor auth callbacks',
      summary: 'Move callback handling behind one service.',
      body: '## Plan\n1. Extract callback service.\n2. Add regression tests.',
      source: 'claude-code',
      sourceRef: 'claude://session/s1',
      metadata: { extractedFrom: 'explicit-marker' },
    });
  });

  it('opens Claude plan-mode Stop responses as unsaved plan drafts when no explicit block is present', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      cwd: '/tmp/project',
      permission_mode: 'plan',
      last_assistant_message: [
        '## Plan: localStorage to Firebase',
        '',
        '### Phase 0 — Audit',
        'Goal: find every localStorage key.',
        '',
        '### Key Risks',
        '- Async UI bugs.',
      ].join('\n'),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/tmp/project',
      title: 'Plan: localStorage to Firebase',
      body: expect.stringContaining('### Phase 0'),
      source: 'claude-plan-mode-stop',
      sourceRef: 'hook://stop/s1',
      metadata: {
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        extractedFrom: 'claude-plan-mode-stop',
      },
    });
  });

  it('does not convert ordinary Stop prose into a plan draft outside Claude plan mode', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      last_assistant_message: '## Plan: this heading alone should not be enough outside plan mode',
    });

    expect(events).toHaveLength(0);
  });

  it('does not infer plans from unmarked Stop prose', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      last_assistant_message: 'Here is a plan in normal prose, but it is not explicitly marked.',
    });

    expect(events).toHaveLength(0);
  });

  it('handles SubagentStart — emits hook:subagent-start', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:subagent-start', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'SubagentStart',
      session_id: 's1',
      agent_id: 'sub-1',
      agent_type: 'explore',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'sub-1', agentType: 'explore' });
  });

  it('handles SubagentStop — emits hook:subagent-stop', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:subagent-stop', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'SubagentStop',
      session_id: 's1',
      agent_id: 'sub-1',
      last_assistant_message: 'Found 3 files',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'sub-1', lastMessage: 'Found 3 files' });
  });

  it('handles PlanProposed — emits provider-neutral plan proposal', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    const result = await router.handleEvent({
      hook_event_name: 'PlanProposed',
      schema: PLAN_PROPOSAL_SCHEMA_VERSION,
      session_id: 's1',
      cwd: '/tmp/project',
      title: 'Refactor auth callbacks',
      summary: 'Move WorkOS callback handling behind one service.',
      plan_markdown: '## Plan\n\n1. Extract service\n2. Add tests',
      source: 'claude-code',
      source_ref: 'claude://session/s1',
      metadata: { providerModel: 'sonnet', secret: 'do-not-broadcast' },
    });

    expect(result).toEqual({ passthrough: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 's1',
      adapter: 'claude',
      cwd: '/tmp/project',
      title: 'Refactor auth callbacks',
      body: '## Plan\n\n1. Extract service\n2. Add tests',
      source: 'claude-code',
      sourceRef: 'claude://session/s1',
      metadata: { providerModel: 'sonnet', schema: PLAN_PROPOSAL_SCHEMA_VERSION },
    });
  });

  it('redacts sensitive hook payloads before invalid base input logging', () => {
    expect(
      safeHookLogInput({
        hook_event_name: 'PlanProposed',
        body: 'secret plan body',
        metadata: { secret: 'token' },
        plan: 'secret alternative body',
        plan_markdown: 'secret markdown body',
        tool_input: { token: 'tool-token' },
        tool_response: { output: 'tool-output' },
        session_id: 's1',
      }),
    ).toEqual({
      hook_event_name: 'PlanProposed',
      adapter: undefined,
      has_session_id: true,
      keys: ['hook_event_name', 'session_id'],
    });
  });

  it('rejects PlanProposed hooks without the explicit plan contract schema', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    const result = await router.handleEvent({
      hook_event_name: 'PlanProposed',
      session_id: 's1',
      body: '## Plan\n\nMissing schema.',
    });

    expect(result).toEqual({ passthrough: true });
    expect(events).toHaveLength(0);
  });

  it('rejects PlanProposed hooks with blank or ambiguous plan bodies', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:plan-proposed', (data) => events.push(data));

    await expect(
      router.handleEvent({
        hook_event_name: 'PlanProposed',
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        session_id: 's1',
        body: '   ',
      }),
    ).resolves.toEqual({ passthrough: true });

    await expect(
      router.handleEvent({
        hook_event_name: 'PlanProposed',
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        session_id: 's1',
        body: 'Plan A',
        plan_markdown: 'Plan B',
      }),
    ).resolves.toEqual({ passthrough: true });

    expect(events).toHaveLength(0);
  });

  it('emits generic hook:event for all events', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:event', (data) => events.push(data));

    await router.handleEvent({
      hook_event_name: 'SessionStart',
      session_id: 's1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'SessionStart', sessionId: 's1' });
  });

  // -------------------------------------------------------------------------
  // Unknown / invalid events
  // -------------------------------------------------------------------------

  it('returns passthrough for unknown event kinds', async () => {
    const result = await router.handleEvent({
      hook_event_name: 'FutureHookFromGemini',
      session_id: 's1',
    });
    expect(result.passthrough).toBe(true);
  });

  it('returns passthrough for missing base fields', async () => {
    const result = await router.handleEvent({ random: 'data' });
    expect(result.passthrough).toBe(true);
  });

  it('returns passthrough for invalid schema data', async () => {
    const result = await router.handleEvent({
      hook_event_name: 'PermissionRequest',
      // Missing session_id — base validation fails
    });
    expect(result.passthrough).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PermissionRequest — blocking behavior
  // -------------------------------------------------------------------------

  it('returns passthrough when not supervised', async () => {
    const result = await router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/junk' },
    });

    expect(result.passthrough).toBe(true);
  });

  it('applies workflow-scoped permission decisions before supervision', async () => {
    const hookEvents: unknown[] = [];
    eventBus.on('workflow:hook-fired', (data) => hookEvents.push(data));

    workflowHookRegistry.register({
      sessionId: 's1',
      workflowRunId: 'run-1',
      workflowNodeId: 'review',
      hooks: {
        PermissionRequest: {
          tools: {
            Bash: { behavior: 'deny', message: 'Bash is disabled for this workflow node' },
          },
          default: { behavior: 'allow' },
        },
      },
    });

    const result = await router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/junk' },
    });

    expect(result).toEqual({
      passthrough: false,
      decision: { behavior: 'deny', message: 'Bash is disabled for this workflow node' },
    });
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toMatchObject({
      workflowRunId: 'run-1',
      workflowNodeId: 'review',
      sessionId: 's1',
      kind: 'PermissionRequest',
      response: {
        passthrough: false,
        decision: { behavior: 'deny' },
      },
    });
  });

  it('records workflow-scoped tool hooks without blocking the agent', async () => {
    const hookEvents: unknown[] = [];
    eventBus.on('workflow:hook-fired', (data) => hookEvents.push(data));

    workflowHookRegistry.register({
      sessionId: 's1',
      workflowRunId: 'run-1',
      workflowNodeId: 'review',
      hooks: {
        PreToolUse: {},
        PostToolUse: {},
        PostToolUseFailure: {},
      },
    });

    const pre = await router.handleEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    });
    const post = await router.handleEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Read',
      tool_response: 'ok',
    });
    const failed = await router.handleEvent({
      hook_event_name: 'PostToolUseFailure',
      session_id: 's1',
      tool_name: 'Bash',
      error: 'command not found',
    });

    expect(pre).toEqual({ passthrough: false });
    expect(post).toEqual({ passthrough: false });
    expect(failed).toEqual({ passthrough: false });
    expect(hookEvents).toHaveLength(3);
    expect(hookEvents[0]).toMatchObject({ kind: 'PreToolUse', workflowNodeId: 'review' });
    expect(hookEvents[1]).toMatchObject({ kind: 'PostToolUse', workflowNodeId: 'review' });
    expect(hookEvents[2]).toMatchObject({ kind: 'PostToolUseFailure', workflowNodeId: 'review' });
  });

  it('blocks and waits for response when supervised', async () => {
    const client = mockClient();
    supervision.supervise('s1', client);

    const permEvents: unknown[] = [];
    eventBus.on('hook:permission-request', (data) => permEvents.push(data));

    // Start the blocking request (don't await yet)
    const resultPromise = router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
    });

    // Should have emitted the permission request
    expect(permEvents).toHaveLength(1);
    const hookRequestId = (permEvents[0] as Record<string, unknown>).hookRequestId as string;

    // Resolve it
    eventBus.emit('hook:permission-response', {
      hookRequestId,
      decision: { behavior: 'allow' },
    });

    const result = await resultPromise;
    expect(result.passthrough).toBe(false);
    expect(result.decision).toEqual({ behavior: 'allow' });
  });

  it('times out and returns passthrough', async () => {
    vi.useFakeTimers();

    const client = mockClient();
    supervision.supervise('s1', client);

    // Override the definition to have a short timeout
    router.registerDefinition({
      kind: 'PermissionRequest',
      blocking: true,
      defaultTimeoutMs: 100,
    });

    const resultPromise = router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
    });

    vi.advanceTimersByTime(150);

    const result = await resultPromise;
    expect(result.passthrough).toBe(true);

    vi.useRealTimers();
  });

  it('resolvePermission returns false for unknown request', () => {
    expect(router.resolvePermission('nonexistent', { behavior: 'allow' })).toBe(false);
  });

  it('releaseSession clears pending permissions', async () => {
    const client = mockClient();
    supervision.supervise('s1', client);

    const resultPromise = router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
    });

    router.releaseSession('s1');

    const result = await resultPromise;
    expect(result.passthrough).toBe(true);
    expect(router.getPendingPermissions().size).toBe(0);
  });

  it('shutdown releases all pending', async () => {
    const client = mockClient();
    supervision.supervise('s1', client);
    supervision.supervise('s2', client);

    const p1 = router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
    });
    const p2 = router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's2',
      tool_name: 'Write',
    });

    router.shutdown();

    expect((await p1).passthrough).toBe(true);
    expect((await p2).passthrough).toBe(true);
    expect(router.getPendingPermissions().size).toBe(0);
  });

  it('denies new permission requests when pending queue is at capacity', async () => {
    const client = mockClient();
    supervision.supervise('s1', client);

    router.registerDefinition({
      kind: 'PermissionRequest',
      blocking: true,
      defaultTimeoutMs: 60_000,
    });

    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 512; i += 1) {
      pending.push(
        router.handleEvent({
          hook_event_name: 'PermissionRequest',
          session_id: 's1',
          tool_name: `Tool-${i}`,
          tool_input: { n: i },
        }),
      );
    }

    expect(router.getPendingPermissions().size).toBe(512);

    const overflow = await router.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Overflow',
      tool_input: {},
    });
    expect(overflow.passthrough).toBe(false);
    expect(overflow.decision).toEqual({
      behavior: 'deny',
      message: 'Permission supervision queue is full',
    });

    router.shutdown();
    await Promise.all(pending);
  });

  // -------------------------------------------------------------------------
  // Adapter parameter
  // -------------------------------------------------------------------------

  it('passes adapter name through events', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:session-start', (data) => events.push(data));

    await router.handleEvent({ hook_event_name: 'SessionStart', session_id: 's1' }, 'gemini');

    expect(events[0]).toMatchObject({ adapter: 'gemini' });
  });

  it('defaults adapter to claude', async () => {
    const events: unknown[] = [];
    eventBus.on('hook:event', (data) => events.push(data));

    await router.handleEvent({ hook_event_name: 'SessionStart', session_id: 's1' });

    expect(events[0]).toMatchObject({ adapter: 'claude' });
  });
});
