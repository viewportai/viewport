import { randomUUID } from 'node:crypto';
import { PLAN_PROPOSAL_SCHEMA_VERSION, sanitizePlanProposalMetadata } from './plan-extractor.js';
import type { DaemonEvents } from '../core/events.js';

export const EPHEMERAL_PLAN_DRAFT_TTL_MS = 60 * 60 * 1000;
export const EPHEMERAL_PLAN_DRAFT_MAX_ENTRIES = 100;

type PlanProposedEvent = DaemonEvents['hook:plan-proposed'];

export interface EphemeralPlanDraft {
  schema: typeof PLAN_PROPOSAL_SCHEMA_VERSION;
  draftId: string;
  workspaceId: string;
  title: string;
  summary: string | null;
  body: string;
  source: string | null;
  sourceRef: string | null;
  sessionId: string;
  hookRequestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export class EphemeralPlanDraftStore {
  private drafts = new Map<string, EphemeralPlanDraft>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = EPHEMERAL_PLAN_DRAFT_TTL_MS,
    private readonly maxEntries = EPHEMERAL_PLAN_DRAFT_MAX_ENTRIES,
  ) {}

  create(workspaceId: string, event: PlanProposedEvent): EphemeralPlanDraft {
    this.prune();
    const createdAt = this.now();
    const draft: EphemeralPlanDraft = {
      schema: PLAN_PROPOSAL_SCHEMA_VERSION,
      draftId: randomUUID(),
      workspaceId,
      title: event.title?.trim() || 'Agent plan',
      summary: event.summary?.trim() || null,
      body: event.body,
      source: event.source ?? event.adapter ?? null,
      sourceRef: event.sourceRef ?? `agent-hook:${event.sessionId}`,
      sessionId: event.sessionId,
      hookRequestId:
        typeof event.metadata?.['hookRequestId'] === 'string'
          ? event.metadata['hookRequestId']
          : null,
      metadata: sanitizePlanProposalMetadata(event.metadata),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.drafts.set(draft.draftId, draft);
    this.pruneToMaxEntries();
    return draft;
  }

  get(draftId: string): EphemeralPlanDraft | null {
    this.prune();
    return this.drafts.get(draftId) ?? null;
  }

  delete(draftId: string): void {
    this.drafts.delete(draftId);
  }

  private prune(): void {
    const now = this.now();
    for (const [draftId, draft] of this.drafts.entries()) {
      if (draft.expiresAt <= now) this.drafts.delete(draftId);
    }
  }

  private pruneToMaxEntries(): void {
    while (this.drafts.size > this.maxEntries) {
      const oldest = [...this.drafts.entries()].sort(
        (left, right) => left[1].createdAt - right[1].createdAt,
      )[0];
      if (!oldest) return;
      this.drafts.delete(oldest[0]);
    }
  }
}
