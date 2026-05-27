import fs from 'node:fs/promises';
import path from 'node:path';
import type { Daemon } from '../core/daemon.js';
import type { AgentRunResult } from '../core/interfaces.js';
import type { SessionConfig } from '../core/types.js';
import type { SessionMessage } from '../core/types.js';
import { addEvent } from './runtime-helpers.js';
import { isFailedSessionReason, waitForPromptSessionComplete } from './session-completion.js';
import { createSessionOutputCollector } from './session-output.js';
import type { WorkflowSessionLinkStore } from './session-links.js';
import { defaultWorktreePath } from './prompt-output.js';
import type {
  WorkflowHookRules,
  WorkflowRunRecord,
  WorkflowTranscriptExcerptMessage,
} from './types.js';
import { workflowHookRegistry } from './hook-registry.js';

export interface WorkflowSessionTarget {
  sessionId?: string;
  nativeSessionId?: string;
  worktreePath?: string;
  output?: string;
  transcriptExcerpt?: WorkflowTranscriptExcerptMessage[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowDaemonSessionContext {
  daemon: Daemon;
  sessionLinks: WorkflowSessionLinkStore;
  saveAndEmit: (run: WorkflowRunRecord) => Promise<void>;
}

export interface WorkflowDaemonSessionRequest {
  run: WorkflowRunRecord;
  nodeId: string;
  target: WorkflowSessionTarget;
  prompt: string;
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  executionMode?: 'plan' | 'read_only' | 'implement' | 'review';
  allowedTools?: string[];
  hooks?: WorkflowHookRules;
  timeoutSeconds?: number;
  outputFallback?: () => Promise<string>;
  outputData?: (output: string) => Promise<Record<string, unknown>>;
}

export interface WorkflowDaemonSessionResult {
  sessionId: string;
  nativeSessionId: string;
  worktreePath: string;
  output: string;
  reason: string;
  agentRun: AgentRunResult;
}

export async function runWorkflowDaemonSession(
  context: WorkflowDaemonSessionContext,
  request: WorkflowDaemonSessionRequest,
): Promise<WorkflowDaemonSessionResult> {
  const { run, nodeId, target } = request;
  const output = createSessionOutputCollector();
  let activeSessionId: string | null = null;

  const messageHandler = (event: { sessionId: string; message: SessionMessage }): void => {
    if (event.sessionId !== activeSessionId) return;
    output.push(event.message);
  };

  context.daemon.on('session:message', messageHandler);
  try {
    const sessionCwd =
      request.cwd ?? path.join(run.directoryPath, '.viewport', 'node-sessions', run.id, nodeId);
    await fs.mkdir(sessionCwd, { recursive: true });
    const directoryId = (
      await context.daemon.directoryManager.register(sessionCwd, {
        gitTracker: {
          enabled: false,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/session-',
          commitAuthor: 'Viewport Agent <noreply@example.test>',
          maxCommitsPerSession: 500,
          worktreeRoot: '.viewport/worktrees',
        },
      })
    ).id;
    const sessionOverrides = {
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.executionMode ? { executionMode: request.executionMode } : {}),
      ...(request.allowedTools ? { allowedTools: request.allowedTools } : {}),
      sandboxMode: request.cwd ? 'workspace-write' : 'read-only',
      approvalPolicy: 'never',
      trust: 'automated',
      contextInjection: 'disabled',
    } satisfies Partial<SessionConfig>;
    validateWorkflowSessionAdapterCapabilities(context, directoryId, sessionOverrides);
    const sessionId = await context.daemon.launchSession(directoryId, request.prompt, sessionOverrides);
    activeSessionId = sessionId;
    const launchedAgent = context.daemon.getSessionInfo(sessionId).agent;
    const nativeSessionId = context.daemon.getSessionNativeId(sessionId);
    const worktreePath =
      readActiveSessionWorktreePath(context.daemon, sessionId) ??
      defaultWorktreePath(run, sessionId);

    target.sessionId = sessionId;
    target.nativeSessionId = nativeSessionId;
    target.worktreePath = worktreePath;

    if (request.hooks) {
      const registration = {
        sessionId,
        workflowRunId: run.id,
        workflowNodeId: nodeId,
        hooks: request.hooks,
      };
      workflowHookRegistry.register(registration);
      if (nativeSessionId !== sessionId) {
        workflowHookRegistry.register({ ...registration, sessionId: nativeSessionId });
      }
    }

    await context.sessionLinks.upsert({
      sessionId,
      nativeSessionId,
      workflowRunId: run.id,
      workflowNodeId: nodeId,
      parentDirectoryId: run.directoryId,
      parentDirectoryPath: run.directoryPath,
      worktreePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    addEvent(
      run,
      'session-started',
      `Node ${nodeId} started session ${sessionId}`,
      { sessionId },
      nodeId,
    );
    run.updatedAt = Date.now();
    await context.saveAndEmit(run);

    const agentStartedAt = Date.now();
    const reason = await waitForPromptSessionComplete(
      context.daemon,
      sessionId,
      request.timeoutSeconds ? request.timeoutSeconds * 1000 : undefined,
    );
    if (reason === 'timeout') {
      await context.daemon.killSession(sessionId).catch(() => undefined);
      throw new Error(`Prompt session timed out after ${request.timeoutSeconds}s`);
    }
    const capturedOutput =
      output.text() || (request.outputFallback ? await request.outputFallback() : '');
    if (capturedOutput && capturedOutput !== target.output) {
      target.output = capturedOutput;
      const outputData = request.outputData ? await request.outputData(capturedOutput) : {};
      const transcriptExcerpt = readTranscriptExcerpt(outputData['transcriptExcerpt']);
      if (transcriptExcerpt) {
        target.transcriptExcerpt = transcriptExcerpt;
      }
      addEvent(
        run,
        'node-output',
        `Node ${nodeId} produced prompt output`,
        {
          output: capturedOutput,
          ...outputData,
        },
        nodeId,
      );
    }

    const agentDescriptor =
      context.daemon.getAgentAdapterDescription(launchedAgent) ?? fallbackAgentDescriptor(launchedAgent);
    const agentRun = output.agentRunResult({
      agent: agentDescriptor,
      ...(request.model ? { model: request.model } : {}),
      ...(request.executionMode ? { executionMode: request.executionMode } : {}),
      startedAt: agentStartedAt,
      completedAt: Date.now(),
      reason,
    });
    target.metadata = {
      ...(target.metadata ?? {}),
      agentRun,
      usage: agentRun.usage,
      toolCalls: agentRun.toolCalls,
      enforcement: agentRun.enforcement,
    };

    addEvent(
      run,
      reason === 'idle' ? 'session-idle' : 'session-ended',
      `Node ${nodeId} session ${sessionId} ${reason === 'idle' ? 'became idle' : 'ended'}`,
      { sessionId, reason },
      nodeId,
    );
    if (isFailedSessionReason(reason)) {
      throw new Error(`Session ${sessionId} failed: ${reason}`);
    }

    return { sessionId, nativeSessionId, worktreePath, output: capturedOutput, reason, agentRun };
  } finally {
    if (activeSessionId) {
      workflowHookRegistry.unregister(activeSessionId);
      try {
        workflowHookRegistry.unregister(context.daemon.getSessionNativeId(activeSessionId));
      } catch {
        // The active session may already be gone during shutdown/error cleanup.
      }
    }
    context.daemon.off('session:message', messageHandler);
  }
}

function fallbackAgentDescriptor(agentId: string) {
  return {
    schema: 'viewport.agent_adapter/v2' as const,
    agentId,
    displayName: agentId,
    adapterVersion: 'unknown',
    capabilities: {
      executionModes: {
        plan: 'unsupported' as const,
        read_only: 'unsupported' as const,
        review: 'prompt_only' as const,
        implement: 'prompt_only' as const,
      },
      toolAllowlist: 'unsupported' as const,
      structuredOutput: 'prompt_only' as const,
      permissionHooks: 'unsupported' as const,
      usageReporting: 'unavailable' as const,
      costReporting: 'unavailable' as const,
      maxTurns: 'unsupported' as const,
      maxBudget: 'unsupported' as const,
      hardTimeout: 'hard' as const,
    },
  };
}

function validateWorkflowSessionAdapterCapabilities(
  context: WorkflowDaemonSessionContext,
  directoryId: string,
  overrides: Partial<SessionConfig>,
): void {
  const config = context.daemon.configManager.resolveSessionConfig(directoryId, overrides);
  const descriptor = context.daemon.getAgentAdapterDescription(config.agent);
  if (!descriptor) {
    throw new Error(`No adapter registered for agent: ${config.agent}`);
  }

  const executionMode = config.executionMode ?? 'implement';
  const modeSupport = descriptor.capabilities.executionModes[executionMode];
  if (executionMode === 'plan' || executionMode === 'read_only') {
    if (modeSupport !== 'hard' && modeSupport !== 'provider') {
      throw new Error(
        `Adapter ${descriptor.agentId} cannot enforce ${executionMode} execution mode for workflow node sessions.`,
      );
    }
  } else if (modeSupport === 'unsupported') {
    throw new Error(
      `Adapter ${descriptor.agentId} does not support ${executionMode} execution mode for workflow node sessions.`,
    );
  }

  if (config.allowedTools && descriptor.capabilities.toolAllowlist !== 'hard' && descriptor.capabilities.toolAllowlist !== 'provider') {
    throw new Error(
      `Adapter ${descriptor.agentId} cannot enforce workflow tool allowlists.`,
    );
  }
}

function readActiveSessionWorktreePath(daemon: Daemon, sessionId: string): string | undefined {
  try {
    return daemon.getSessionWorktreePath(sessionId);
  } catch {
    return undefined;
  }
}

function readTranscriptExcerpt(value: unknown): WorkflowTranscriptExcerptMessage[] | null {
  if (!Array.isArray(value)) return null;

  const excerpt = value.flatMap((entry): WorkflowTranscriptExcerptMessage[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const role = record['role'];
    const text = record['text'];
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || !text.trim()) {
      return [];
    }
    return [{ role, text }];
  });

  return excerpt.length > 0 ? excerpt : null;
}
