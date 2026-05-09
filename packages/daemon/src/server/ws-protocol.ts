/**
 * Zod schemas for incoming WebSocket messages.
 *
 * Implements the Viewport wire protocol (plan/03_protocol.md):
 * launch, kill, prompt, respond-permission, subscribe/unsubscribe,
 * rollback, branch-retry, squash-merge, list-sessions, resume, sync-request.
 */

import { z } from 'zod';
import type { WorkflowInputValue } from '../workflows/types.js';

const MAX_PROMPT_CHARS = 100_000;
const MAX_MODEL_CHARS = 200;
const MAX_THINKING_MODE_CHARS = 32;
const MAX_REQUEST_ID_CHARS = 128;
const MAX_IMAGE_BYTES_BASE64_CHARS = 2_000_000;
const MAX_IMAGE_COUNT = 4;

const WorkflowInputValueSchema: z.ZodType<WorkflowInputValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(WorkflowInputValueSchema),
    z.record(z.string(), WorkflowInputValueSchema),
  ]),
);
const MAX_LIST_SESSIONS_LIMIT = 200;
export const MAX_READ_SESSION_MESSAGES_LIMIT = 200;

const ImageSchema = z.object({
  data: z.string().max(MAX_IMAGE_BYTES_BASE64_CHARS),
  mediaType: z.string().max(100),
});

// ---------------------------------------------------------------------------
// Individual message schemas
// ---------------------------------------------------------------------------

export const LaunchSchema = z
  .object({
    type: z.literal('launch'),
    directoryId: z.string().min(1).max(512),
    resourceId: z.string().min(1).max(256).optional(),
    prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
    model: z.string().max(MAX_MODEL_CHARS).optional(),
    thinkingMode: z.string().max(MAX_THINKING_MODE_CHARS).optional(),
    images: z.array(ImageSchema).max(MAX_IMAGE_COUNT).optional(),
    configOverrides: z
      .object({
        agent: z.string().max(64).optional(),
        model: z.string().max(MAX_MODEL_CHARS).optional(),
        costCapUsd: z.number().optional(),
        trust: z.enum(['operator', 'automated', 'external']).optional(),
      })
      .optional(),
    requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
  })
  .strict();

export const KillSchema = z.object({
  type: z.literal('kill'),
  sessionId: z.string().min(1).max(256),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const PromptSchema = z.object({
  type: z.literal('prompt'),
  sessionId: z.string().min(1).max(256),
  text: z.string().max(MAX_PROMPT_CHARS),
  images: z.array(ImageSchema).max(MAX_IMAGE_COUNT).optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const RespondPermissionSchema = z.object({
  type: z.literal('respond-permission'),
  sessionId: z.string().min(1).max(256),
  permissionRequestId: z.string().min(1).max(256),
  decision: z.object({
    behavior: z.enum(['allow', 'deny', 'allow-always']),
    message: z.string().max(500).optional(),
  }),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const SubscribeSchema = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string().min(1).max(256),
  lastSeq: z.number().int().nonnegative().optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const UnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  sessionId: z.string().min(1).max(256),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const RollbackSchema = z.object({
  type: z.literal('rollback'),
  sessionId: z.string().min(1).max(256),
  toSha: z.string().regex(/^[a-f0-9]{7,40}$/),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const BranchRetrySchema = z.object({
  type: z.literal('branch-retry'),
  sessionId: z.string().min(1).max(256),
  fromSha: z.string().regex(/^[a-f0-9]{7,40}$/),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const SquashMergeSchema = z.object({
  type: z.literal('squash-merge'),
  sessionId: z.string().min(1).max(256),
  targetBranch: z.string().min(1).max(256),
  commitMessage: z.string().min(1).max(5000),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const ListSessionsSchema = z.object({
  type: z.literal('list-sessions'),
  directoryId: z.string().min(1).max(512),
  limit: z.number().int().positive().max(MAX_LIST_SESSIONS_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const ReadSessionMessagesSchema = z.object({
  type: z.literal('read-session-messages'),
  directoryId: z.string().min(1).max(512),
  sessionId: z.string().min(1).max(256),
  limit: z.number().int().positive().max(MAX_READ_SESSION_MESSAGES_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
  delivery: z.enum(['ack', 'event-stream']).optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const ResumeSchema = z
  .object({
    type: z.literal('resume'),
    sessionId: z.string().min(1).max(256),
    directoryId: z.string().min(1).max(512),
    resourceId: z.string().min(1).max(256).optional(),
    prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
    model: z.string().max(MAX_MODEL_CHARS).optional(),
    requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
  })
  .strict();

export const WatchDiscoveredSessionSchema = z.object({
  type: z.literal('watch-discovered-session'),
  sessionId: z.string().min(1).max(256),
  directoryId: z.string().min(1).max(512).optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const UnwatchDiscoveredSessionSchema = z.object({
  type: z.literal('unwatch-discovered-session'),
  sessionId: z.string().min(1).max(256),
  directoryId: z.string().min(1).max(512).optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const SyncRequestSchema = z.object({
  type: z.literal('sync-request'),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const WorkflowRunSchema = z
  .object({
    type: z.literal('workflow-run'),
    workflowPath: z.string().min(1).max(4096).optional(),
    workflowYaml: z.string().min(1).max(256_000).optional(),
    workflowSourceRef: z.string().min(1).max(4096).optional(),
    directoryId: z.string().min(1).max(512),
    inputs: z.record(z.string(), WorkflowInputValueSchema).optional(),
    resourceId: z.string().min(1).max(256).optional(),
    runtimeTargetId: z.string().min(1).max(256).optional(),
    platformRunId: z.string().min(1).max(256).optional(),
    rerunOfWorkflowRunId: z.string().min(1).max(256).optional(),
    executionPolicy: z
      .object({
        mode: z.enum(['current_tree', 'isolated_worktree', 'named_branch']),
        branch: z.string().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
    dataCapturePolicy: z
      .object({
        transcripts: z.enum(['none', 'excerpt']),
        logs: z.enum(['metadata', 'content']),
        artifacts: z.enum(['metadata', 'local_reference']),
      })
      .strict()
      .optional(),
    requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.workflowPath || value.workflowYaml), {
    message: 'workflowPath or workflowYaml is required',
    path: ['workflowPath'],
  });

export const WorkflowListRunsSchema = z.object({
  type: z.literal('workflow-list-runs'),
  limit: z.number().int().positive().max(200).optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const WorkflowShowRunSchema = z.object({
  type: z.literal('workflow-show-run'),
  runId: z.string().min(1).max(256),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const WorkflowApproveRunSchema = z.object({
  type: z.literal('workflow-approve'),
  runId: z.string().min(1).max(256),
  nodeId: z.string().min(1).max(256),
  approved: z.boolean(),
  message: z.string().max(2_000).optional(),
  actor: z
    .object({
      id: z.string().max(255).optional(),
      name: z.string().max(255).optional(),
      email: z.string().email().max(255).optional(),
      source: z.string().max(255).optional(),
    })
    .optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const WorkflowCancelRunSchema = z.object({
  type: z.literal('workflow-cancel'),
  runId: z.string().min(1).max(256),
  message: z.string().max(2_000).optional(),
  actor: z
    .object({
      id: z.string().max(255).optional(),
      name: z.string().max(255).optional(),
      email: z.string().email().max(255).optional(),
      source: z.string().max(255).optional(),
    })
    .optional(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

// ---------------------------------------------------------------------------
// Supervision (hook-based remote permission control)
// ---------------------------------------------------------------------------

export const SuperviseSchema = z.object({
  type: z.literal('supervise'),
  sessionId: z.string().min(1).max(256),
  active: z.boolean(),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

export const RespondHookPermissionSchema = z.object({
  type: z.literal('respond-hook-permission'),
  hookRequestId: z.string().min(1).max(256),
  decision: z.object({
    behavior: z.enum(['allow', 'deny']),
    message: z.string().max(500).optional(),
  }),
  requestId: z.string().max(MAX_REQUEST_ID_CHARS).optional(),
});

// ---------------------------------------------------------------------------
// Discriminated union of all incoming messages
// ---------------------------------------------------------------------------

export const IncomingMessageSchema = z.discriminatedUnion('type', [
  LaunchSchema,
  KillSchema,
  PromptSchema,
  RespondPermissionSchema,
  SubscribeSchema,
  UnsubscribeSchema,
  RollbackSchema,
  BranchRetrySchema,
  SquashMergeSchema,
  ListSessionsSchema,
  ReadSessionMessagesSchema,
  ResumeSchema,
  WatchDiscoveredSessionSchema,
  UnwatchDiscoveredSessionSchema,
  SyncRequestSchema,
  WorkflowRunSchema,
  WorkflowListRunsSchema,
  WorkflowShowRunSchema,
  WorkflowApproveRunSchema,
  WorkflowCancelRunSchema,
  SuperviseSchema,
  RespondHookPermissionSchema,
]);

export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
