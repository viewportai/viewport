import { runWorkflowDaemonSession } from './daemon-session.js';
import { addEvent, renderTemplate } from './runtime-helpers.js';
import {
  resolveInlineAgentExecutionMode,
  resolveWorkflowSessionPolicy,
  type WorkflowSessionBudget,
} from './session-policy.js';
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
  options: { budget?: WorkflowSessionBudget } = {},
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
        ...((agent.effort ?? node.effort) ? { effort: agent.effort ?? node.effort } : {}),
        executionMode: resolveInlineAgentExecutionMode({
          explicitExecutionMode: agent.executionMode,
          parentExecutionMode: node.executionMode,
        }),
      },
    ]),
  );
  run.updatedAt = Date.now();
  await context.saveAndEmit(run);

  const results = await Promise.allSettled(
    entries.map(async ([agentId, agent]) => {
      const agentState = state.inlineAgents?.[agentId];
      if (!agentState) return;
      const sessionPolicy = resolveWorkflowSessionPolicy({
        executionMode: agentState.executionMode,
        timeoutSeconds: agent.timeoutSeconds,
      });
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
          ...(agentState.effort ? { effort: agentState.effort } : {}),
          executionMode: sessionPolicy.executionMode,
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
          ...(agentState.effort ? { effort: agentState.effort } : {}),
          executionMode: sessionPolicy.executionMode,
          ...(agent.allowedTools
            ? { allowedTools: agent.allowedTools }
            : sessionPolicy.executionMode === 'plan'
              ? { allowedTools: [] }
              : {}),
          timeoutSeconds: sessionPolicy.timeoutSeconds,
          ...(options.budget ? { budget: options.budget } : {}),
          executionModeDefaulted: agent.executionMode === undefined,
          timeoutDefaulted: sessionPolicy.timeoutDefaulted,
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
        if (node.inlineAgentFailurePolicy !== 'continue') throw error;
      } finally {
        run.updatedAt = Date.now();
        await context.saveAndEmit(run);
      }
    }),
  );

  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0 && node.inlineAgentFailurePolicy !== 'continue') {
    const reason = failures[0]?.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  return state.inlineAgents ?? {};
}

export function appendInlineAgentResults(
  prompt: string,
  agents: Record<string, WorkflowInlineAgentRunState>,
): string {
  const reportable = Object.values(agents).filter(
    (agent) => agent.status === 'completed' || agent.status === 'failed',
  );
  if (reportable.length === 0) return prompt;

  const lines = [
    prompt,
    '',
    'Viewport inline agent results:',
    ...reportable.flatMap((agent) => [
      '',
      `## ${agent.title ?? agent.id}`,
      `Agent: ${agent.agent ?? 'default'}${agent.model ? ` (${agent.model})` : ''}`,
      `Status: ${agent.status}`,
      agent.status === 'failed'
        ? `Error: ${agent.error ?? 'Unknown inline agent failure.'}`
        : agent.output?.trim()
          ? agent.output.trim()
          : 'No output captured.',
    ]),
  ];
  return lines.join('\n');
}
