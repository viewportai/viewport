import { addEvent } from './runtime-helpers.js';
import type { WorkflowRunStore } from './store.js';
import type { WorkflowRunRecord } from './types.js';

export interface WorkflowHookEventPayload {
  workflowRunId: string;
  workflowNodeId: string;
  sessionId: string;
  kind: string;
  adapter: string;
  response?: {
    passthrough: boolean;
    decision?: { behavior: 'allow' | 'deny'; message?: string };
  };
  payload: Record<string, unknown>;
}

export async function recordWorkflowHookEvent(
  store: WorkflowRunStore,
  saveAndEmit: (run: WorkflowRunRecord) => Promise<void>,
  event: WorkflowHookEventPayload,
): Promise<void> {
  const run = await store.get(event.workflowRunId);
  if (!run) return;
  addEvent(
    run,
    'hook-fired',
    `Workflow hook ${event.kind} fired for node ${event.workflowNodeId}`,
    {
      kind: event.kind,
      adapter: event.adapter,
      sessionId: event.sessionId,
      response: event.response ?? null,
      payload: event.payload,
    },
    event.workflowNodeId,
  );
  run.updatedAt = Date.now();
  await saveAndEmit(run);
}
