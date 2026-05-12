import type { TypedEventEmitter } from '../core/events.js';
import type { DaemonEvents } from '../core/events.js';
import type { HookEventKind } from './types.js';
import {
  extractPlanProposalFromText,
  PLAN_PROPOSAL_SCHEMA_VERSION,
  sanitizePlanProposalMetadata,
} from './plan-extractor.js';

type SpecificEventContext = {
  sessionId: string;
  adapter: string;
  cwd?: string;
};

export function emitSpecificHookEvent(
  eventBus: TypedEventEmitter<DaemonEvents>,
  kind: HookEventKind,
  data: Record<string, unknown>,
  ctx: SpecificEventContext,
): void {
  switch (kind) {
    case 'SessionStart':
      eventBus.emit('hook:session-start', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        cwd: data.cwd as string | undefined,
        source: data.source as string | undefined,
        agentType: data.agent_type as string | undefined,
        model: data.model as string | undefined,
      });
      break;
    case 'SessionEnd':
      eventBus.emit('hook:session-end', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        reason: data.reason as string | undefined,
      });
      break;
    case 'Notification':
      eventBus.emit('hook:notification', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        message: (data.message as string) ?? '',
        title: data.title as string | undefined,
        notificationType: data.notification_type as string | undefined,
      });
      break;
    case 'PostToolUse':
      eventBus.emit('hook:tool-completed', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        toolName: (data.tool_name as string) ?? '',
        toolInput: data.tool_input,
        toolResponse: data.tool_response,
      });
      break;
    case 'PreToolUse':
      emitPlanProposalFromExitPlanMode(eventBus, data, ctx);
      break;
    case 'PostToolUseFailure':
      eventBus.emit('hook:tool-failed', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        toolName: (data.tool_name as string) ?? '',
        error: data.error as string | undefined,
        isInterrupt: data.is_interrupt as boolean | undefined,
      });
      break;
    case 'Stop':
      eventBus.emit('hook:stop', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        lastMessage: data.last_assistant_message as string | undefined,
      });
      emitExplicitPlanProposalFromStop(eventBus, data, ctx);
      break;
    case 'SubagentStart':
      eventBus.emit('hook:subagent-start', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        agentId: data.agent_id as string | undefined,
        agentType: data.agent_type as string | undefined,
      });
      break;
    case 'SubagentStop':
      eventBus.emit('hook:subagent-stop', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        agentId: data.agent_id as string | undefined,
        agentType: data.agent_type as string | undefined,
        lastMessage: data.last_assistant_message as string | undefined,
      });
      break;
    case 'PlanProposed':
      eventBus.emit('hook:plan-proposed', {
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        cwd: data.cwd as string | undefined,
        title: data.title as string | undefined,
        summary: data.summary as string | undefined,
        body: planBodyFromData(data),
        source: data.source as string | undefined,
        sourceRef: data.source_ref as string | undefined,
        metadata: {
          ...sanitizePlanProposalMetadata(readRecord(data.metadata)),
          schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        },
      });
      break;
    default:
      break;
  }
}

function emitPlanProposalFromExitPlanMode(
  eventBus: TypedEventEmitter<DaemonEvents>,
  data: Record<string, unknown>,
  ctx: SpecificEventContext,
): void {
  if (data.tool_name !== 'ExitPlanMode') return;
  const toolInput = readRecord(data.tool_input);
  const plan = toolInput?.plan;
  if (typeof plan !== 'string' || plan.trim().length === 0) return;
  const planFilePath =
    typeof toolInput?.planFilePath === 'string' ? toolInput.planFilePath : undefined;

  eventBus.emit('hook:plan-proposed', {
    sessionId: ctx.sessionId,
    adapter: ctx.adapter,
    cwd: ctx.cwd,
    title: titleFromMarkdown(plan),
    body: plan.trim(),
    source: `${ctx.adapter}-exit-plan-mode`,
    sourceRef: `hook://exit-plan-mode/${ctx.sessionId}`,
    metadata: {
      schema: PLAN_PROPOSAL_SCHEMA_VERSION,
      extractedFrom: 'exit-plan-mode',
      planFilePath,
    },
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  return value as Record<string, unknown>;
}

function planBodyFromData(data: Record<string, unknown>): string {
  for (const field of ['body', 'plan_markdown', 'plan'] as const) {
    const value = data[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }

  return '';
}

function titleFromMarkdown(markdown: string): string | undefined {
  const firstHeading = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line));
  return firstHeading?.replace(/^#{1,3}\s+/, '').trim();
}

function emitExplicitPlanProposalFromStop(
  eventBus: TypedEventEmitter<DaemonEvents>,
  data: Record<string, unknown>,
  ctx: SpecificEventContext,
): void {
  const proposal = extractPlanProposalFromText(data.last_assistant_message as string | undefined);
  if (!proposal) return;

  eventBus.emit('hook:plan-proposed', {
    sessionId: ctx.sessionId,
    adapter: ctx.adapter,
    cwd: ctx.cwd,
    title: proposal.title,
    summary: proposal.summary,
    body: proposal.body,
    source: proposal.source ?? `${ctx.adapter}-stop`,
    sourceRef: proposal.sourceRef ?? `hook://stop/${ctx.sessionId}`,
    metadata: {
      ...(proposal.metadata ?? {}),
      extractedFrom: 'explicit-marker',
    },
  });
}
