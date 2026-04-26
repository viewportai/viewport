import { runWorkflowDaemonSession } from './daemon-session.js';
import { addEvent, renderTemplate } from './runtime-helpers.js';
import type { WorkflowNodeExecutorContext } from './node-executor.js';
import type {
  WorkflowInlineAgentRunState,
  WorkflowPromptNode,
  WorkflowRunRecord,
} from './types.js';

export async function runInlineAgents(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowPromptNode,
): Promise<Record<string, WorkflowInlineAgentRunState>> {
  const entries = Object.entries(node.agents ?? {});
  const state = run.nodes[nodeId];
  if (!state || entries.length === 0) return {};

  state.inlineAgents = Object.fromEntries(
    entries.map(([agentId, agent]) => [
      agentId,
      {
        id: agentId,
        status: 'queued' as const,
        ...(agent.title ? { title: agent.title } : {}),
        ...((agent.agent ?? node.agent) ? { agent: agent.agent ?? node.agent } : {}),
        ...((agent.model ?? node.model) ? { model: agent.model ?? node.model } : {}),
      },
    ]),
  );
  run.updatedAt = Date.now();
  await context.saveAndEmit(run);

  await Promise.all(
    entries.map(async ([agentId, agent]) => {
      const agentState = state.inlineAgents?.[agentId];
      if (!agentState) return;
      agentState.status = 'running';
      agentState.startedAt = Date.now();
      addEvent(
        run,
        'inline-agent-started',
        `Inline agent ${agentId} started for node ${nodeId}`,
        {
          agentId,
          ...(agentState.agent ? { agent: agentState.agent } : {}),
          ...(agentState.model ? { model: agentState.model } : {}),
        },
        nodeId,
      );
      run.updatedAt = agentState.startedAt;
      await context.saveAndEmit(run);

      try {
        await runWorkflowDaemonSession(context, {
          run,
          nodeId,
          target: agentState,
          prompt: await renderTemplate(agent.prompt, run),
          ...(agentState.agent ? { agent: agentState.agent } : {}),
          ...(agentState.model ? { model: agentState.model } : {}),
        });
        agentState.status = 'completed';
        agentState.completedAt = Date.now();
        addEvent(
          run,
          'inline-agent-completed',
          `Inline agent ${agentId} completed for node ${nodeId}`,
          { agentId, output: agentState.output ?? '' },
          nodeId,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        agentState.status = 'failed';
        agentState.completedAt = Date.now();
        agentState.error = message;
        addEvent(
          run,
          'inline-agent-failed',
          `Inline agent ${agentId} failed for node ${nodeId}: ${message}`,
          { agentId, error: message },
          nodeId,
        );
        throw error;
      } finally {
        run.updatedAt = Date.now();
        await context.saveAndEmit(run);
      }
    }),
  );

  return state.inlineAgents ?? {};
}

export function appendInlineAgentResults(
  prompt: string,
  agents: Record<string, WorkflowInlineAgentRunState>,
): string {
  const completed = Object.values(agents).filter((agent) => agent.status === 'completed');
  if (completed.length === 0) return prompt;

  const lines = [
    prompt,
    '',
    'Viewport inline agent results:',
    ...completed.flatMap((agent) => [
      '',
      `## ${agent.title ?? agent.id}`,
      `Agent: ${agent.agent ?? 'default'}${agent.model ? ` (${agent.model})` : ''}`,
      agent.output?.trim() ? agent.output.trim() : 'No output captured.',
    ]),
  ];
  return lines.join('\n');
}
