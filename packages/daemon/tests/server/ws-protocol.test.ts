import { describe, it, expect } from 'vitest';
import {
  LaunchSchema,
  KillSchema,
  PromptSchema,
  RespondPermissionSchema,
  SubscribeSchema,
  RollbackSchema,
  BranchRetrySchema,
  SquashMergeSchema,
  ListSessionsSchema,
  ReadSessionMessagesSchema,
  ResumeSchema,
  WatchDiscoveredSessionSchema,
  UnwatchDiscoveredSessionSchema,
  WorkflowRunSchema,
  WorkflowListRunsSchema,
  WorkflowShowRunSchema,
  WorkflowApproveRunSchema,
  WorkflowCancelRunSchema,
  SuperviseSchema,
  RespondHookPermissionSchema,
  IncomingMessageSchema,
} from '../../src/server/ws-protocol.js';

describe('LaunchSchema', () => {
  it('accepts minimal launch message', () => {
    const result = LaunchSchema.safeParse({ type: 'launch', directoryId: 'dir-1' });
    expect(result.success).toBe(true);
  });

  it('accepts launch with all optional fields', () => {
    const result = LaunchSchema.safeParse({
      type: 'launch',
      directoryId: 'dir-1',
      resourceId: 'resource-1',
      prompt: 'Fix the bug',
      model: 'claude-sonnet-4-20250514',
      configOverrides: { agent: 'claude', costCapUsd: 5.0, trust: 'operator' },
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects legacy project scope fields', () => {
    const result = LaunchSchema.safeParse({
      type: 'launch',
      directoryId: 'dir-1',
      projectId: 'project-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing directoryId', () => {
    const result = LaunchSchema.safeParse({ type: 'launch' });
    expect(result.success).toBe(false);
  });

  it('rejects launch prompt exceeding max length', () => {
    const result = LaunchSchema.safeParse({
      type: 'launch',
      directoryId: 'dir-1',
      prompt: 'x'.repeat(100001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects too many launch images', () => {
    const result = LaunchSchema.safeParse({
      type: 'launch',
      directoryId: 'dir-1',
      images: Array.from({ length: 5 }, () => ({ data: 'abc', mediaType: 'image/png' })),
    });
    expect(result.success).toBe(false);
  });
});

describe('KillSchema', () => {
  it('accepts valid kill message', () => {
    const result = KillSchema.safeParse({ type: 'kill', sessionId: 's1' });
    expect(result.success).toBe(true);
  });

  it('rejects missing sessionId', () => {
    const result = KillSchema.safeParse({ type: 'kill' });
    expect(result.success).toBe(false);
  });
});

describe('PromptSchema', () => {
  it('accepts valid prompt message', () => {
    const result = PromptSchema.safeParse({ type: 'prompt', sessionId: 's1', text: 'hello' });
    expect(result.success).toBe(true);
  });

  it('rejects text exceeding max length', () => {
    const longText = 'x'.repeat(100001);
    const result = PromptSchema.safeParse({ type: 'prompt', sessionId: 's1', text: longText });
    expect(result.success).toBe(false);
  });

  it('rejects missing text field', () => {
    const result = PromptSchema.safeParse({ type: 'prompt', sessionId: 's1' });
    expect(result.success).toBe(false);
  });

  it('rejects too many prompt images', () => {
    const result = PromptSchema.safeParse({
      type: 'prompt',
      sessionId: 's1',
      text: 'hello',
      images: Array.from({ length: 5 }, () => ({ data: 'abc', mediaType: 'image/png' })),
    });
    expect(result.success).toBe(false);
  });
});

describe('RespondPermissionSchema', () => {
  it('accepts allow decision', () => {
    const result = RespondPermissionSchema.safeParse({
      type: 'respond-permission',
      sessionId: 's1',
      permissionRequestId: 'pr-1',
      decision: { behavior: 'allow' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts deny decision with message', () => {
    const result = RespondPermissionSchema.safeParse({
      type: 'respond-permission',
      sessionId: 's1',
      permissionRequestId: 'pr-1',
      decision: { behavior: 'deny', message: 'Not allowed' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts allow-always decision', () => {
    const result = RespondPermissionSchema.safeParse({
      type: 'respond-permission',
      sessionId: 's1',
      permissionRequestId: 'pr-1',
      decision: { behavior: 'allow-always' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid behavior', () => {
    const result = RespondPermissionSchema.safeParse({
      type: 'respond-permission',
      sessionId: 's1',
      permissionRequestId: 'pr-1',
      decision: { behavior: 'maybe' },
    });
    expect(result.success).toBe(false);
  });
});

describe('SubscribeSchema', () => {
  it('accepts minimal subscribe', () => {
    const result = SubscribeSchema.safeParse({ type: 'subscribe', sessionId: 's1' });
    expect(result.success).toBe(true);
  });

  it('accepts subscribe with lastSeq', () => {
    const result = SubscribeSchema.safeParse({ type: 'subscribe', sessionId: 's1', lastSeq: 42 });
    expect(result.success).toBe(true);
  });

  it('rejects negative lastSeq', () => {
    const result = SubscribeSchema.safeParse({ type: 'subscribe', sessionId: 's1', lastSeq: -1 });
    expect(result.success).toBe(false);
  });
});

describe('RollbackSchema', () => {
  it('accepts valid 7-char SHA', () => {
    const result = RollbackSchema.safeParse({
      type: 'rollback',
      sessionId: 's1',
      toSha: 'abc1234',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid 40-char SHA', () => {
    const result = RollbackSchema.safeParse({
      type: 'rollback',
      sessionId: 's1',
      toSha: 'a'.repeat(40),
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid SHA format', () => {
    const result = RollbackSchema.safeParse({
      type: 'rollback',
      sessionId: 's1',
      toSha: 'not-a-sha',
    });
    expect(result.success).toBe(false);
  });

  it('rejects SHA shorter than 7 chars', () => {
    const result = RollbackSchema.safeParse({ type: 'rollback', sessionId: 's1', toSha: 'abc12' });
    expect(result.success).toBe(false);
  });

  it('rejects SHA longer than 40 chars', () => {
    const result = RollbackSchema.safeParse({
      type: 'rollback',
      sessionId: 's1',
      toSha: 'a'.repeat(41),
    });
    expect(result.success).toBe(false);
  });

  it('rejects SHA with uppercase letters', () => {
    const result = RollbackSchema.safeParse({
      type: 'rollback',
      sessionId: 's1',
      toSha: 'ABC1234',
    });
    expect(result.success).toBe(false);
  });
});

describe('BranchRetrySchema', () => {
  it('accepts valid message', () => {
    const result = BranchRetrySchema.safeParse({
      type: 'branch-retry',
      sessionId: 's1',
      fromSha: 'abc1234',
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal payload without prompt', () => {
    const result = BranchRetrySchema.safeParse({
      type: 'branch-retry',
      sessionId: 's1',
      fromSha: 'abc1234',
    });
    expect(result.success).toBe(true);
  });
});

describe('Workflow schemas', () => {
  it('accepts a workflow run command', () => {
    const result = WorkflowRunSchema.safeParse({
      type: 'workflow-run',
      workflowYaml:
        'schema: viewport.workflow/v1\nname: proof\nnodes:\n  one:\n    type: shell\n    command: echo ok\n',
      workflowSourceRef: 'viewport://templates/proof',
      directoryId: 'dir-1',
      inputs: {
        pr: '123',
        integration_event: {
          provider: 'github',
          payload: { number: 42, labels: ['needs-review'] },
        },
      },
      resourceId: 'context-main',
      runtimeTargetId: 'runtime-target-1',
      platformRunId: 'platform-run-1',
      rerunOfWorkflowRunId: 'source-run-1',
      executionPolicy: { mode: 'named_branch', branch: 'main' },
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects legacy project workflow target fields', () => {
    const result = WorkflowRunSchema.safeParse({
      type: 'workflow-run',
      workflowYaml:
        'schema: viewport.workflow/v1\nname: proof\nnodes:\n  one:\n    type: shell\n    command: echo ok\n',
      directoryId: 'dir-1',
      resourceId: 'context-main',
      runtimeTargetId: 'runtime-target-1',
      projectId: 'project-1',
      projectMachineBindingId: 'binding-1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a workflow list command', () => {
    const result = WorkflowListRunsSchema.safeParse({
      type: 'workflow-list-runs',
      limit: 25,
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a workflow show command', () => {
    const result = WorkflowShowRunSchema.safeParse({
      type: 'workflow-show-run',
      runId: 'run-1',
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a workflow approval command', () => {
    const result = WorkflowApproveRunSchema.safeParse({
      type: 'workflow-approve',
      runId: 'run-1',
      nodeId: 'gate',
      approved: true,
      message: 'ship it',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'viewport-web',
      },
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a workflow cancel command', () => {
    const result = WorkflowCancelRunSchema.safeParse({
      type: 'workflow-cancel',
      runId: 'run-1',
      message: 'Stop this run',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'viewport-web',
      },
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
  });
});

describe('SquashMergeSchema', () => {
  it('accepts valid message', () => {
    const result = SquashMergeSchema.safeParse({
      type: 'squash-merge',
      sessionId: 's1',
      targetBranch: 'main',
      commitMessage: 'Merge session work',
    });
    expect(result.success).toBe(true);
  });
});

describe('ListSessionsSchema', () => {
  it('accepts minimal message', () => {
    const result = ListSessionsSchema.safeParse({
      type: 'list-sessions',
      directoryId: 'dir-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts with pagination', () => {
    const result = ListSessionsSchema.safeParse({
      type: 'list-sessions',
      directoryId: 'dir-1',
      limit: 10,
      offset: 20,
    });
    expect(result.success).toBe(true);
  });

  it('rejects limit above guardrail', () => {
    const result = ListSessionsSchema.safeParse({
      type: 'list-sessions',
      directoryId: 'dir-1',
      limit: 500,
    });
    expect(result.success).toBe(false);
  });
});

describe('ReadSessionMessagesSchema', () => {
  it('accepts a bounded transcript read request', () => {
    const result = ReadSessionMessagesSchema.safeParse({
      type: 'read-session-messages',
      directoryId: 'dir-1',
      sessionId: 's1',
      limit: 500,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unbounded transcript reads above the guardrail', () => {
    const result = ReadSessionMessagesSchema.safeParse({
      type: 'read-session-messages',
      directoryId: 'dir-1',
      sessionId: 's1',
      limit: 5000,
    });
    expect(result.success).toBe(false);
  });
});

describe('ResumeSchema', () => {
  it('accepts valid resume', () => {
    const result = ResumeSchema.safeParse({
      type: 'resume',
      sessionId: 's1',
      directoryId: 'dir-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts resume with prompt', () => {
    const result = ResumeSchema.safeParse({
      type: 'resume',
      sessionId: 's1',
      directoryId: 'dir-1',
      resourceId: 'resource-1',
      prompt: 'Continue from where you left off',
    });
    expect(result.success).toBe(true);
  });

  it('rejects legacy project scope fields', () => {
    const result = ResumeSchema.safeParse({
      type: 'resume',
      sessionId: 's1',
      directoryId: 'dir-1',
      projectId: 'project-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('WatchDiscoveredSessionSchema', () => {
  it('accepts valid message', () => {
    const result = WatchDiscoveredSessionSchema.safeParse({
      type: 'watch-discovered-session',
      sessionId: 's1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts directory-scoped watch', () => {
    const result = WatchDiscoveredSessionSchema.safeParse({
      type: 'watch-discovered-session',
      sessionId: 's1',
      directoryId: 'dir-1',
    });
    expect(result.success).toBe(true);
  });
});

describe('UnwatchDiscoveredSessionSchema', () => {
  it('accepts valid message', () => {
    const result = UnwatchDiscoveredSessionSchema.safeParse({
      type: 'unwatch-discovered-session',
      sessionId: 's1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts directory-scoped unwatch', () => {
    const result = UnwatchDiscoveredSessionSchema.safeParse({
      type: 'unwatch-discovered-session',
      sessionId: 's1',
      directoryId: 'dir-1',
    });
    expect(result.success).toBe(true);
  });
});

describe('SuperviseSchema', () => {
  it('accepts supervise active', () => {
    const result = SuperviseSchema.safeParse({
      type: 'supervise',
      sessionId: 's1',
      active: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts supervise inactive', () => {
    const result = SuperviseSchema.safeParse({
      type: 'supervise',
      sessionId: 's1',
      active: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing sessionId', () => {
    const result = SuperviseSchema.safeParse({ type: 'supervise', active: true });
    expect(result.success).toBe(false);
  });

  it('rejects missing active field', () => {
    const result = SuperviseSchema.safeParse({ type: 'supervise', sessionId: 's1' });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean active', () => {
    const result = SuperviseSchema.safeParse({
      type: 'supervise',
      sessionId: 's1',
      active: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('RespondHookPermissionSchema', () => {
  it('accepts allow decision', () => {
    const result = RespondHookPermissionSchema.safeParse({
      type: 'respond-hook-permission',
      hookRequestId: 'hk-1-123',
      decision: { behavior: 'allow' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts deny decision with message', () => {
    const result = RespondHookPermissionSchema.safeParse({
      type: 'respond-hook-permission',
      hookRequestId: 'hk-1-123',
      decision: { behavior: 'deny', message: 'Too dangerous' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing hookRequestId', () => {
    const result = RespondHookPermissionSchema.safeParse({
      type: 'respond-hook-permission',
      decision: { behavior: 'allow' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing decision', () => {
    const result = RespondHookPermissionSchema.safeParse({
      type: 'respond-hook-permission',
      hookRequestId: 'hk-1-123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid behavior', () => {
    const result = RespondHookPermissionSchema.safeParse({
      type: 'respond-hook-permission',
      hookRequestId: 'hk-1-123',
      decision: { behavior: 'allow-always' },
    });
    expect(result.success).toBe(false);
  });
});

describe('IncomingMessageSchema discriminated union', () => {
  it('dispatches to correct schema by type', () => {
    const launch = IncomingMessageSchema.safeParse({ type: 'launch', directoryId: 'd1' });
    expect(launch.success).toBe(true);

    const kill = IncomingMessageSchema.safeParse({ type: 'kill', sessionId: 's1' });
    expect(kill.success).toBe(true);
  });

  it('dispatches supervise and respond-hook-permission', () => {
    const supervise = IncomingMessageSchema.safeParse({
      type: 'supervise',
      sessionId: 's1',
      active: true,
    });
    expect(supervise.success).toBe(true);

    const respond = IncomingMessageSchema.safeParse({
      type: 'respond-hook-permission',
      hookRequestId: 'hk-1',
      decision: { behavior: 'deny' },
    });
    expect(respond.success).toBe(true);
  });

  it('rejects unknown type', () => {
    const result = IncomingMessageSchema.safeParse({ type: 'explode', sessionId: 's1' });
    expect(result.success).toBe(false);
  });

  it('rejects missing type', () => {
    const result = IncomingMessageSchema.safeParse({ sessionId: 's1' });
    expect(result.success).toBe(false);
  });
});
