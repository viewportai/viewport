/**
 * Hook system types — adapter-agnostic event definitions for agent lifecycle hooks.
 *
 * The hook system allows the daemon to receive events from any agent (Claude Code,
 * Gemini, Cursor, etc.) via lightweight CLI commands that POST to the daemon.
 * Each hook event has a typed input schema and metadata about how it should be handled.
 *
 * Design:
 *   - HookEventKind: all supported event names (extensible enum-like union)
 *   - HookInput<K>: typed input for each event kind
 *   - HookEventDefinition: registry entry with schema, blocking flag, handler
 *   - HookResponse: what the daemon returns to the hook command
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Hook event kinds — add new events here
// ---------------------------------------------------------------------------

export const HOOK_EVENT_KINDS = [
  'SessionStart',
  'SessionEnd',
  'PermissionRequest',
  'Notification',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'TaskCompleted',
  'PlanProposed',
] as const;

export type HookEventKind = (typeof HOOK_EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Base input — all hook events include these fields
// ---------------------------------------------------------------------------

export const HookBaseInputSchema = z.object({
  hook_event_name: z.string(),
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
});

export type HookBaseInput = z.infer<typeof HookBaseInputSchema>;

// ---------------------------------------------------------------------------
// Per-event input schemas
// ---------------------------------------------------------------------------

export const SessionStartInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('SessionStart'),
  source: z.enum(['startup', 'resume', 'clear', 'compact']).optional(),
  agent_type: z.string().optional(),
  model: z.string().optional(),
});

export const SessionEndInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('SessionEnd'),
  reason: z.string().optional(),
});

export const PermissionRequestInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('PermissionRequest'),
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
});

export const NotificationInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('Notification'),
  message: z.string(),
  title: z.string().optional(),
  notification_type: z.string().optional(),
});

export const StopInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('Stop'),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
});

export const PreToolUseInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
});

export const PostToolUseInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
});

export const PostToolUseFailureInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('PostToolUseFailure'),
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  error: z.string().optional(),
  is_interrupt: z.boolean().optional(),
});

export const SubagentStartInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('SubagentStart'),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});

export const SubagentStopInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('SubagentStop'),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
  last_assistant_message: z.string().optional(),
});

export const UserPromptSubmitInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string().optional(),
});

export const TaskCompletedInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('TaskCompleted'),
  task_id: z.string().optional(),
  task_subject: z.string().optional(),
  task_description: z.string().optional(),
});

export const PlanProposedInputSchema = HookBaseInputSchema.extend({
  hook_event_name: z.literal('PlanProposed'),
  title: z.string().optional(),
  summary: z.string().optional(),
  body: z.string().optional(),
  plan: z.string().optional(),
  plan_markdown: z.string().optional(),
  source: z.string().optional(),
  source_ref: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Schema registry — maps event kind to its Zod schema
// ---------------------------------------------------------------------------

export const HOOK_INPUT_SCHEMAS: Record<HookEventKind, z.ZodType> = {
  SessionStart: SessionStartInputSchema,
  SessionEnd: SessionEndInputSchema,
  PermissionRequest: PermissionRequestInputSchema,
  Notification: NotificationInputSchema,
  Stop: StopInputSchema,
  PreToolUse: PreToolUseInputSchema,
  PostToolUse: PostToolUseInputSchema,
  PostToolUseFailure: PostToolUseFailureInputSchema,
  SubagentStart: SubagentStartInputSchema,
  SubagentStop: SubagentStopInputSchema,
  UserPromptSubmit: UserPromptSubmitInputSchema,
  TaskCompleted: TaskCompletedInputSchema,
  PlanProposed: PlanProposedInputSchema,
};

// ---------------------------------------------------------------------------
// Hook responses
// ---------------------------------------------------------------------------

/** Returned to the hook CLI command. */
export interface HookResponse {
  /** If true, the hook should exit non-zero so the agent falls through to its own UI. */
  passthrough: boolean;
  /** Permission decision (only for PermissionRequest). */
  decision?: { behavior: 'allow' | 'deny'; message?: string };
}

// ---------------------------------------------------------------------------
// Hook event definition — registry entry for extensible handler registration
// ---------------------------------------------------------------------------

export interface HookContext {
  /** The adapter/agent that sent this event (e.g., 'claude', 'gemini'). */
  adapter: string;
}

export interface HookEventDefinition {
  /** The event kind this definition handles. */
  kind: HookEventKind;
  /** Whether the hook should block and wait for a response (e.g., PermissionRequest). */
  blocking: boolean;
  /** Default timeout in ms for blocking hooks. */
  defaultTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Default event definitions — blocking vs fire-and-forget
// ---------------------------------------------------------------------------

export const DEFAULT_EVENT_DEFINITIONS: HookEventDefinition[] = [
  { kind: 'SessionStart', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'SessionEnd', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'PermissionRequest', blocking: true, defaultTimeoutMs: 120_000 },
  { kind: 'Notification', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'Stop', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'PreToolUse', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'PostToolUse', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'PostToolUseFailure', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'SubagentStart', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'SubagentStop', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'UserPromptSubmit', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'TaskCompleted', blocking: false, defaultTimeoutMs: 5_000 },
  { kind: 'PlanProposed', blocking: false, defaultTimeoutMs: 5_000 },
];
