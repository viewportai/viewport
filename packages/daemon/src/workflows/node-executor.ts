import fs from 'node:fs/promises';
import path from 'node:path';
import type { Daemon } from '../core/daemon.js';
import {
  addEvent,
  renderOptionalTemplate,
  renderTemplate,
  resolveNodeCwd,
  ShellNodeError,
} from './runtime-helpers.js';
import type { WorkflowSessionLinkStore } from './session-links.js';
import { collectNodeArtifacts } from './artifact-collector.js';
import { readPromptNodeOutput, readPromptNodeTranscriptExcerpt } from './prompt-output.js';
import { classifyRetry } from './retry-classifier.js';
import { NODE_EXECUTORS } from './node-registry.js';
import { runWorkflowDaemonSession } from './daemon-session.js';
import { appendInlineAgentResults, runInlineAgents } from './inline-agents.js';
import { resolveWorkflowRunSessionBudget, resolveWorkflowSessionPolicy } from './session-policy.js';
import { resolvePromptNodeContext } from './context-node-resolver.js';
import { parseWorkflow } from './parser.js';
import type { WorkflowPlatformContextClient } from './platform-context-client.js';
import type { WorkflowShellAbortRegistry } from './shell-abort-registry.js';
import type { WorkflowNode, WorkflowRunRecord } from './types.js';

export interface ApprovalBlockOptions {
  gateIntent?: unknown;
  reviewerTags?: unknown;
  timeout?: unknown;
  onTimeout?: unknown;
}

export interface WorkflowNodeExecutorContext {
  daemon: Daemon;
  sessionLinks: WorkflowSessionLinkStore;
  shellAbortRegistry: WorkflowShellAbortRegistry;
  /**
   * Run-scoped secret material fetched through the Viewport lease path. This
   * map is transient process memory only and is never persisted with the run.
   */
  runtimeSecretEnv?: Record<string, string>;
  /**
   * Run-scoped secret file paths fetched through the Viewport lease path.
   * These are transient process handoff references only and are never
   * persisted with the run.
   */
  runtimeSecretFiles?: Record<string, string>;
  platformContextClient?: WorkflowPlatformContextClient;
  saveAndEmit: (run: WorkflowRunRecord) => Promise<void>;
}

export async function executeWorkflowNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
): Promise<'completed' | 'blocked'> {
  const state = run.nodes[nodeId];
  if (!state) return 'completed';
  if (state.status === 'completed' || state.status === 'skipped') return 'completed';

  const startedAt = Date.now();
  state.status = 'running';
  state.startedAt = startedAt;
  state.metadata = {
    ...(state.metadata ?? {}),
    node_contract_ack: preExecuteNodeContractAcknowledgement(run, nodeId, node, startedAt),
  };
  run.updatedAt = state.startedAt;
  addEvent(
    run,
    'node-contract-acknowledged',
    `Node ${nodeId} authority contract acknowledged before execution`,
    {
      nodeId,
      nodeType: node.type,
      status: 'acknowledged',
      enforcement: nodeContractEnforcement(run),
    },
    nodeId,
  );
  addEvent(run, 'node-started', `Node ${nodeId} started`, undefined, nodeId);
  await context.saveAndEmit(run);

  const maxAttempts = node.retry?.maxAttempts ?? 1;
  const backoffMs = (node.retry?.backoffSeconds ?? 0) * 1000;
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      // Look up the per-type executor in the registry. Built-ins are
      // registered in `node-registry.ts`; the plugin loader will extend the
      // same map with `defineNode()` registrations from
      // `~/.viewport/plugins.json` once that integration ships.
      const executor = NODE_EXECUTORS.get(node.type);
      if (!executor) {
        throw new Error(`No executor registered for node type '${node.type}' on node ${nodeId}.`);
      }
      const outcome = await executor(context, run, nodeId, node, {
        executePromptNode,
        executeGateNode,
        blockForApproval,
      });
      if (outcome.result === 'blocked') return 'blocked';

      await collectAndRecordArtifacts(
        context,
        run,
        nodeId,
        node,
        outcome.artifactCwd ?? run.directoryPath,
      );

      state.status = 'completed';
      state.completedAt = Date.now();
      run.updatedAt = state.completedAt;
      addEvent(run, 'node-completed', `Node ${nodeId} completed`, undefined, nodeId);
      await context.saveAndEmit(run);
      return 'completed';
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ShellNodeError) {
        state.output = error.output || state.output;
        state.exitCode = error.exitCode ?? undefined;
      }
      const decision = classifyRetry(message, node.retry);
      const remaining = maxAttempts - attempt;
      if (decision === 'retry' && remaining > 0) {
        addEvent(
          run,
          'node-retry',
          `Node ${nodeId} retry ${attempt + 1}/${maxAttempts}: ${message}`,
          { attempt, message, backoffMs },
          nodeId,
        );
        run.updatedAt = Date.now();
        await context.saveAndEmit(run);
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      break;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  state.status = 'failed';
  state.error = message;
  state.completedAt = Date.now();
  state.attempts = attempt;
  run.updatedAt = state.completedAt;
  if (node.type === 'action') {
    const action = isRecord(state.metadata?.['action']) ? state.metadata['action'] : {};
    const idempotencyKey =
      typeof action['idempotencyKey'] === 'string' ? action['idempotencyKey'] : null;
    const digest = typeof action['digest'] === 'string' ? action['digest'] : null;
    const recovery = {
      state: 'dead_letter',
      reason: message,
      attempts: attempt,
      retryableByRerun: Boolean(idempotencyKey),
      idempotencyKey,
      digest,
    };
    state.metadata = {
      ...(state.metadata ?? {}),
      action: {
        ...action,
        recovery,
      },
    };
    addEvent(
      run,
      'action-dead-letter',
      `Action node ${nodeId} needs remediation after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
      recovery,
      nodeId,
    );
  }
  addEvent(run, 'node-failed', `Node ${nodeId} failed: ${message}`, { attempts: attempt }, nodeId);
  await context.saveAndEmit(run);
  throw lastError instanceof Error ? lastError : new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function preExecuteNodeContractAcknowledgement(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
  acknowledgedAt: number,
): Record<string, unknown> {
  return {
    schema: 'viewport.node_contract_acknowledgement/v1',
    status: 'acknowledged',
    source: 'daemon_pre_execute',
    runner: run.machineId ?? 'local-daemon',
    node_id: nodeId,
    node_type: node.type,
    acknowledged_at: new Date(acknowledgedAt).toISOString(),
    enforcement: nodeContractEnforcement(run),
    modeled: run.workflowAuthorityContract ? ['tools', 'budgets'] : ['repos', 'tools', 'budgets'],
  };
}

function nodeContractEnforcement(run: WorkflowRunRecord): Record<string, string> {
  const authorityEnforced = run.workflowAuthorityContract ? 'contract_guarded' : 'modeled';

  return {
    context: run.workflowAuthorityContract ? 'contract_guarded' : 'enforced',
    data_capture: 'enforced',
    credentials: 'materialization_guarded',
    side_effects: run.workflowAuthorityContract ? 'contract_guarded' : 'approval_guarded',
    repos: authorityEnforced,
    tools: 'modeled',
    budgets: 'modeled',
  };
}

async function executeGateNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: Extract<WorkflowNode, { type: 'gate' }>,
): Promise<'completed' | 'blocked'> {
  const gate = node.gate;
  if (gate.type === 'human_review') {
    await blockForApproval(context, run, nodeId, await renderTemplate(gate.prompt, run));
    addEvent(run, 'gate-blocked', `Human review gate ${nodeId} is waiting`, { gate }, nodeId);
    await context.saveAndEmit(run);
    return 'blocked';
  }

  if (gate.type === 'schedule') {
    const waitUntil = new Date(await renderTemplate(gate.waitUntil, run));
    if (!Number.isFinite(waitUntil.getTime())) {
      throw new Error(`Schedule gate ${nodeId} has an invalid waitUntil value`);
    }
    if (waitUntil.getTime() > Date.now()) {
      const state = run.nodes[nodeId];
      if (state) {
        state.status = 'blocked';
        state.output = `Waiting until ${waitUntil.toISOString()}`;
      }
      run.status = 'blocked';
      run.updatedAt = Date.now();
      addEvent(
        run,
        'gate-blocked',
        `Schedule gate ${nodeId} is waiting until ${waitUntil.toISOString()}`,
        { gate, waitUntil: waitUntil.toISOString() },
        nodeId,
      );
      await context.saveAndEmit(run);
      return 'blocked';
    }

    setGateOutput(run, nodeId, `Schedule reached: ${waitUntil.toISOString()}`);
    addEvent(
      run,
      'gate-passed',
      `Schedule gate ${nodeId} passed`,
      { gate, waitUntil: waitUntil.toISOString() },
      nodeId,
    );
    return 'completed';
  }

  const rendered = await renderTemplate(gate.expression, run);
  if (!isTruthyGateValue(rendered)) {
    throw new Error(`${gate.type} gate ${nodeId} failed: ${rendered || 'false'}`);
  }

  setGateOutput(run, nodeId, rendered);
  addEvent(
    run,
    'gate-passed',
    `${gate.type} gate ${nodeId} passed`,
    { gate, result: rendered },
    nodeId,
  );
  return 'completed';
}

function setGateOutput(run: WorkflowRunRecord, nodeId: string, output: string): void {
  const state = run.nodes[nodeId];
  if (state) state.output = output;
}

function isTruthyGateValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'pass', 'passed', 'ok'].includes(normalized);
}

async function collectAndRecordArtifacts(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
  cwd: string,
): Promise<void> {
  if (!node.artifacts || Object.keys(node.artifacts).length === 0) return;
  const result = await collectNodeArtifacts(run, nodeId, node, cwd);
  const contextBasis = run.nodes[nodeId]?.metadata?.['context_basis'];
  const contextBriefing = run.nodes[nodeId]?.metadata?.['context_briefing'];
  for (const artifact of result.artifacts) {
    if (contextBasis) {
      artifact.metadata = {
        ...(artifact.metadata ?? {}),
        context_basis: contextBasis,
        ...(contextBriefing ? { context_briefing: contextBriefing } : {}),
      };
    }
    run.artifacts ??= [];
    run.artifacts = run.artifacts.filter(
      (existing) => existing.nodeId !== artifact.nodeId || existing.name !== artifact.name,
    );
    run.artifacts.push(artifact);
    addEvent(
      run,
      'artifact-collected',
      `Node ${nodeId} collected artifact ${artifact.name}`,
      { artifact },
      nodeId,
    );
  }
  for (const missing of result.missing) {
    addEvent(
      run,
      'artifact-missing',
      `Node ${nodeId} did not collect artifact ${missing.name}: ${missing.reason}`,
      missing,
      nodeId,
    );
  }
  if (result.artifacts.length > 0 || result.missing.length > 0) {
    run.updatedAt = Date.now();
    await context.saveAndEmit(run);
  }
}

async function executePromptNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: Extract<WorkflowNode, { type: 'prompt' }>,
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;
  const sessionPolicy = resolveWorkflowSessionPolicy({
    executionMode: node.executionMode,
    timeoutSeconds: node.timeoutSeconds,
  });
  const parsed = parseWorkflow(run.yamlSnapshot, run.sourcePath ?? `viewport://runs/${run.id}`);
  const budget = resolveWorkflowRunSessionBudget(
    parsed.definition.policies?.budget,
    run.workflowAuthorityContract,
  );
  const inlineAgents = await runInlineAgents(context, run, nodeId, node, { budget });
  const renderedPrompt = appendInlineAgentResults(
    await renderTemplate(node.prompt, run),
    inlineAgents,
  );
  const renderedCwd = await renderOptionalTemplate(node.cwd, run);
  const selectedContext = await resolvePromptNodeContext({
    run,
    nodeId,
    workflowContext: parsed.definition.context,
    nodeContext: node.context,
    prompt: renderedPrompt,
    platformContextClient: context.platformContextClient,
  });
  if (selectedContext.basis.mode !== 'none') {
    state.outputs = {
      ...(state.outputs ?? {}),
      context_basis: selectedContext.basis,
      context_briefing: selectedContext.briefing,
    };
    state.metadata = {
      ...(state.metadata ?? {}),
      context_basis: selectedContext.basis,
      context_briefing: selectedContext.briefing,
    };
  }

  await runWorkflowDaemonSession(context, {
    run,
    nodeId,
    target: state,
    ...(renderedCwd ? { cwd: resolveNodeCwd(run.directoryPath, renderedCwd) } : {}),
    prompt: selectedContext.promptBlock
      ? [
          selectedContext.promptBlock,
          '',
          workflowInputsPromptBlock(run),
          '',
          '<user_request>',
          renderedPrompt,
          '</user_request>',
        ].join('\n')
      : [
          workflowInputsPromptBlock(run),
          '',
          '<user_request>',
          renderedPrompt,
          '</user_request>',
        ].join('\n'),
    ...(node.agent ? { agent: node.agent } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.effort ? { effort: node.effort } : {}),
    executionMode: sessionPolicy.executionMode,
    allowedTools: node.allowedTools ?? [],
    ...(node.hooks ? { hooks: node.hooks } : {}),
    timeoutSeconds: sessionPolicy.timeoutSeconds,
    ...(budget ? { budget } : {}),
    executionModeDefaulted: sessionPolicy.executionModeDefaulted,
    timeoutDefaulted: sessionPolicy.timeoutDefaulted,
    outputFallback: () =>
      readPromptNodeOutput(run, state, { allowCodexDiscovery: node.agent === 'codex' }),
    outputData: async () => {
      const transcriptExcerpt = await readPromptNodeTranscriptExcerpt(run, state, {
        allowCodexDiscovery: node.agent === 'codex',
      });
      return transcriptExcerpt.length > 0 ? { transcriptExcerpt } : {};
    },
  });

  await verifyPromptRequiredFiles(run, nodeId, node, renderedCwd);
}

function workflowInputsPromptBlock(run: WorkflowRunRecord): string {
  const json = JSON.stringify(run.inputs, null, 2);
  const maxChars = 12_000;
  const body =
    json.length > maxChars
      ? `${json.slice(0, maxChars)}\n...truncated ${json.length - maxChars} chars`
      : json;

  return ['<workflow_inputs>', body, '</workflow_inputs>'].join('\n');
}

async function verifyPromptRequiredFiles(
  run: WorkflowRunRecord,
  nodeId: string,
  node: Extract<WorkflowNode, { type: 'prompt' }>,
  renderedCwd: string | undefined,
): Promise<void> {
  if (!node.requiredFiles || node.requiredFiles.length === 0) return;

  const root = renderedCwd ? resolveNodeCwd(run.directoryPath, renderedCwd) : run.directoryPath;
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const fileTemplate of node.requiredFiles) {
    const renderedFile = await renderTemplate(fileTemplate, run);
    if (path.isAbsolute(renderedFile)) {
      invalid.push(renderedFile);
      continue;
    }
    const candidate = path.resolve(root, renderedFile);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      invalid.push(renderedFile);
      continue;
    }
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) missing.push(renderedFile);
    } catch {
      missing.push(renderedFile);
    }
  }

  if (invalid.length > 0 || missing.length > 0) {
    const details = [
      invalid.length > 0 ? `invalid required file path(s): ${invalid.join(', ')}` : null,
      missing.length > 0 ? `missing required file(s): ${missing.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    addEvent(
      run,
      'node-failed',
      `Prompt node ${nodeId} did not produce required files: ${details}`,
      { requiredFiles: node.requiredFiles, invalid, missing, cwd: root },
      nodeId,
    );
    throw new Error(`Prompt node ${nodeId} did not produce required files: ${details}`);
  }
}

async function blockForApproval(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  prompt: string,
  options: ApprovalBlockOptions = {},
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;

  const requestedAt = Date.now();
  const metadata = {
    ...(state.metadata ?? {}),
    ...approvalBlockMetadata(options, requestedAt),
  };
  state.status = 'blocked';
  state.metadata = metadata;
  state.approval = {
    prompt,
    requestedAt,
  };
  run.status = 'blocked';
  run.updatedAt = state.approval.requestedAt;
  addEvent(run, 'approval-requested', `Approval requested for node ${nodeId}`, { prompt }, nodeId);
  addEvent(run, 'run-blocked', `Workflow blocked by approval gate: ${nodeId}`, undefined, nodeId);
  await context.saveAndEmit(run);
}

function approvalBlockMetadata(
  options: ApprovalBlockOptions,
  requestedAt: number,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const gateIntent = stringValue(options.gateIntent);
  if (gateIntent === 'plan' || gateIntent === 'approval') {
    metadata['gate_intent'] = gateIntent;
  }

  if (Array.isArray(options.reviewerTags)) {
    const reviewerTags = options.reviewerTags.filter(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    if (reviewerTags.length > 0) {
      metadata['reviewer_tags'] = reviewerTags;
    }
  }

  const onTimeout = stringValue(options.onTimeout);
  if (onTimeout === 'escalate' || onTimeout === 'auto-approve' || onTimeout === 'cancel') {
    metadata['on_timeout'] = onTimeout;
  }

  const timeoutAt = timeoutAtIso(options.timeout, requestedAt);
  if (timeoutAt) {
    metadata['timeout_at'] = timeoutAt;
  }

  return metadata;
}

function timeoutAtIso(value: unknown, requestedAt: number): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const match = raw.match(
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i,
  );
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const multiplier = unit.startsWith('s')
    ? 1_000
    : unit.startsWith('m')
      ? 60_000
      : unit.startsWith('h')
        ? 3_600_000
        : 86_400_000;

  return new Date(requestedAt + amount * multiplier).toISOString();
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
