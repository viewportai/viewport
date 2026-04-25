import type { Daemon } from '../core/daemon.js';
import { parseWorkflow, parseWorkflowFile, workflowNodeOrder } from './parser.js';
import { preflightWorkflow } from './preflight.js';
import { addEvent, normalizeInputs } from './runtime-helpers.js';
import { executeWorkflowNode } from './node-executor.js';
import { getSessionState, readReplaySessionState } from './session-completion.js';
import { readPromptNodeOutput, readPromptNodeTranscriptExcerpt } from './prompt-output.js';
import { WorkflowRunPlatformSync } from './platform-sync.js';
import { WorkflowSessionLinkStore } from './session-links.js';
import { WorkflowRunStore } from './store.js';
import { resolveWorkflowSource } from './workflow-source.js';
import type {
  ParsedWorkflow,
  WorkflowApprovalDecision,
  WorkflowNodeRunState,
  WorkflowRunRecord,
  WorkflowRunRequest,
} from './types.js';

export class WorkflowRunner {
  private readonly store = new WorkflowRunStore();
  private readonly sessionLinks = new WorkflowSessionLinkStore();
  private readonly platformSync: WorkflowRunPlatformSync;
  private readonly activeRunIds = new Set<string>();

  constructor(private readonly daemon: Daemon) {
    this.platformSync = new WorkflowRunPlatformSync(daemon.configManager);
  }

  async validateFile(filePath: string): Promise<ParsedWorkflow> {
    return parseWorkflowFile(filePath);
  }

  validateText(sourceText: string, sourceRef = 'viewport://workflow/inline'): ParsedWorkflow {
    return parseWorkflow(sourceText, sourceRef);
  }

  async listRuns(limit?: number): Promise<WorkflowRunRecord[]> {
    const runs = await this.store.list(limit);
    const reconciled = await Promise.all(runs.map((run) => this.reconcileRun(run)));
    return reconciled;
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    const run = await this.store.get(runId);
    return run ? this.reconcileRun(run) : null;
  }

  async startRun(request: WorkflowRunRequest): Promise<WorkflowRunRecord> {
    const directory = this.daemon.directoryManager.get(request.directoryId);
    if (!directory) {
      throw new Error(`Directory not registered: ${request.directoryId}`);
    }

    const parsed = await resolveWorkflowSource(request, directory.path);
    const now = Date.now();
    const run: WorkflowRunRecord = {
      id: crypto.randomUUID(),
      workflowName: parsed.definition.name,
      workflowTitle: parsed.definition.title,
      sourceType: request.workflowYaml ? 'viewport_snapshot' : 'local_file',
      sourcePath: request.workflowYaml ? request.workflowSourceRef : parsed.sourcePath,
      digest: parsed.digest,
      schema: parsed.definition.schema,
      yamlSnapshot: parsed.sourceText,
      directoryId: request.directoryId,
      directoryPath: directory.path,
      projectId: request.projectId,
      projectMachineBindingId: request.projectMachineBindingId,
      platformRunId: request.platformRunId,
      machineId: this.daemon.configManager.getMachineId(),
      executionPolicy: request.executionPolicy,
      initiation: request.initiation,
      status: 'queued',
      inputs: normalizeInputs(parsed, request.inputs ?? {}),
      preflight: { ok: true, issues: [] },
      nodes: Object.fromEntries(
        Object.entries(parsed.definition.nodes).map(([nodeId, node]) => [
          nodeId,
          {
            id: nodeId,
            type: node.type,
            title: node.title,
            status: 'queued',
            metadata: workflowNodeMetadata(node),
          } satisfies WorkflowNodeRunState,
        ]),
      ),
      artifacts: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    addEvent(run, 'run-created', 'Workflow run created');
    if (run.executionPolicy) {
      addEvent(
        run,
        'execution-policy-selected',
        `Execution policy selected: ${formatExecutionPolicy(run.executionPolicy)}`,
        { executionPolicy: run.executionPolicy },
      );
    }
    await this.store.save(run);
    void this.executeRun(run.id, parsed).catch((error) => {
      void this.failRun(run.id, error instanceof Error ? error.message : String(error));
    });
    return run;
  }

  async decideApproval(
    runId: string,
    nodeId: string,
    decision: WorkflowApprovalDecision,
  ): Promise<WorkflowRunRecord> {
    const run = await this.requireRun(runId);
    const state = run.nodes[nodeId];
    if (!state || (state.type !== 'approval' && state.type !== 'gate')) {
      throw new Error(`Workflow approval node not found: ${nodeId}`);
    }
    if (run.status !== 'blocked' || state.status !== 'blocked') {
      throw new Error(`Workflow node is not awaiting approval: ${nodeId}`);
    }

    const resolvedAt = Date.now();
    state.approval = {
      prompt: state.approval?.prompt ?? 'Approval requested',
      requestedAt: state.approval?.requestedAt ?? resolvedAt,
      resolvedAt,
      approved: decision.approved,
      ...(decision.message ? { message: decision.message } : {}),
      ...(decision.actor ? { actor: decision.actor } : {}),
    };

    if (!decision.approved) {
      state.status = 'failed';
      state.error = decision.message ?? 'Approval denied';
      state.completedAt = resolvedAt;
      run.status = 'canceled';
      run.error = state.error;
      run.completedAt = resolvedAt;
      run.updatedAt = resolvedAt;
      addEvent(
        run,
        'approval-resolved',
        `Approval denied for node ${nodeId}`,
        { ...decision },
        nodeId,
      );
      addEvent(run, 'run-failed', `Workflow canceled by approval gate: ${nodeId}`);
      await this.saveAndEmit(run);
      return run;
    }

    state.status = 'completed';
    state.completedAt = resolvedAt;
    state.output = decision.message ?? 'Approved';
    run.status = 'running';
    run.updatedAt = resolvedAt;
    addEvent(
      run,
      'approval-resolved',
      `Approval granted for node ${nodeId}`,
      { ...decision },
      nodeId,
    );
    addEvent(run, 'node-completed', `Node ${nodeId} completed`, undefined, nodeId);
    await this.saveAndEmit(run);

    const parsed = parseWorkflow(run.yamlSnapshot, run.sourcePath ?? `viewport://runs/${run.id}`);
    void this.executeRun(run.id, parsed, { resumed: true }).catch((error) => {
      void this.failRun(run.id, error instanceof Error ? error.message : String(error));
    });
    return run;
  }

  private async executeRun(
    runId: string,
    parsed: ParsedWorkflow,
    options: { resumed?: boolean } = {},
  ): Promise<void> {
    this.activeRunIds.add(runId);
    try {
      const run = await this.requireRun(runId);
      run.status = 'running';
      run.updatedAt = Date.now();
      addEvent(
        run,
        'run-started',
        options.resumed ? 'Workflow run resumed' : 'Workflow run started',
      );
      run.preflight = await preflightWorkflow(parsed.definition, {
        availableAgents: () => this.daemon.getAvailableAgents(),
        directoryPath: run.directoryPath,
      });

      if (!run.preflight.ok) {
        run.status = 'blocked';
        run.completedAt = Date.now();
        run.updatedAt = run.completedAt;
        addEvent(run, 'run-blocked', 'Workflow blocked by preflight', {
          issues: run.preflight.issues,
        });
        await this.saveAndEmit(run);
        return;
      }

      await this.saveAndEmit(run);

      for (const nodeId of workflowNodeOrder(parsed.definition)) {
        const freshRun = await this.requireRun(runId);
        if (freshRun.status !== 'running') return;
        const node = parsed.definition.nodes[nodeId];
        if (!node) continue;
        const result = await executeWorkflowNode(
          {
            daemon: this.daemon,
            sessionLinks: this.sessionLinks,
            saveAndEmit: (nextRun) => this.saveAndEmit(nextRun),
          },
          freshRun,
          nodeId,
          node,
        );
        if (result === 'blocked') return;
      }

      const complete = await this.requireRun(runId);
      complete.status = 'completed';
      complete.completedAt = Date.now();
      complete.updatedAt = complete.completedAt;
      addEvent(complete, 'run-completed', 'Workflow run completed');
      await this.saveAndEmit(complete);
    } finally {
      this.activeRunIds.delete(runId);
    }
  }

  private async failRun(runId: string, message: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run || run.status === 'completed' || run.status === 'failed') return;
    run.status = 'failed';
    run.error = message;
    run.completedAt = Date.now();
    run.updatedAt = run.completedAt;
    addEvent(run, 'run-failed', `Workflow run failed: ${message}`);
    await this.saveAndEmit(run);
  }

  private async requireRun(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.store.get(runId);
    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }
    return this.reconcileRun(run);
  }

  private async saveAndEmit(run: WorkflowRunRecord): Promise<void> {
    await this.store.save(run);
    this.daemon.emit('workflow:run-updated', { run });
    void this.platformSync.sync(run).catch(() => undefined);
  }

  private async reconcileRun(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    if (!['queued', 'running'].includes(run.status)) {
      return this.backfillPromptOutputs(run);
    }
    if (this.activeRunIds.has(run.id)) return run;

    let changed = false;
    for (const node of Object.values(run.nodes)) {
      if (node.status !== 'running' || node.type !== 'prompt' || !node.sessionId) continue;

      const state =
        getSessionState(this.daemon, node.sessionId) ??
        (await readReplaySessionState(node.sessionId));
      if (state === 'idle' || state === 'completed') {
        node.output = node.output || (await readPromptNodeOutput(run, node));
        node.status = 'completed';
        node.completedAt = node.completedAt ?? Date.now();
        run.updatedAt = node.completedAt;
        addEvent(
          run,
          state === 'idle' ? 'session-idle' : 'session-ended',
          `Node ${node.id} session ${node.sessionId} ${state === 'idle' ? 'became idle' : 'ended'}`,
          { sessionId: node.sessionId, reason: state },
          node.id,
        );
        addEvent(run, 'node-completed', `Node ${node.id} completed`, undefined, node.id);
        changed = true;
      } else if (state === 'errored') {
        node.status = 'failed';
        node.error = `Session ${node.sessionId} errored`;
        node.completedAt = Date.now();
        run.status = 'failed';
        run.error = node.error;
        run.completedAt = node.completedAt;
        run.updatedAt = node.completedAt;
        addEvent(run, 'node-failed', `Node ${node.id} failed: ${node.error}`, undefined, node.id);
        addEvent(run, 'run-failed', `Workflow run failed: ${node.error}`);
        changed = true;
      }
    }

    if (changed && Object.values(run.nodes).every((node) => node.status === 'completed')) {
      run.status = 'completed';
      run.completedAt = run.completedAt ?? Date.now();
      run.updatedAt = run.completedAt;
      addEvent(run, 'run-completed', 'Workflow run completed');
    }

    if (changed) {
      await this.saveAndEmit(run);
    }

    return run;
  }

  private async backfillPromptOutputs(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    let changed = false;
    for (const node of Object.values(run.nodes)) {
      if (node.type !== 'prompt' || node.output || !node.sessionId) continue;
      const output = await readPromptNodeOutput(run, node);
      if (!output) continue;
      node.output = output;
      run.updatedAt = Date.now();
      const transcriptExcerpt = await readPromptNodeTranscriptExcerpt(run, node);
      addEvent(
        run,
        'node-output',
        `Node ${node.id} recovered prompt output`,
        {
          output,
          ...(transcriptExcerpt.length > 0 ? { transcriptExcerpt } : {}),
        },
        node.id,
      );
      changed = true;
    }

    if (changed) {
      await this.saveAndEmit(run);
    }

    return run;
  }
}

function workflowNodeMetadata(
  node: ParsedWorkflow['definition']['nodes'][string],
): Record<string, unknown> {
  return {
    needs: node.needs ?? [],
    outputs: node.outputs ?? {},
    artifacts: node.artifacts ?? {},
    retry: node.retry ?? null,
    policy: node.policy ?? null,
    timeoutSeconds: node.timeoutSeconds ?? null,
    ...(node.type === 'prompt'
      ? {
          agent: node.agent ?? null,
          provider: node.provider ?? null,
          model: node.model ?? null,
        }
      : {}),
    ...(node.type === 'gate' ? { gate: node.gate } : {}),
  };
}

function formatExecutionPolicy(policy: NonNullable<WorkflowRunRecord['executionPolicy']>): string {
  if (policy.mode === 'named_branch') {
    return `named branch${policy.branch ? ` ${policy.branch}` : ''}`;
  }
  if (policy.mode === 'current_tree') return 'selected working tree';
  return 'isolated agent worktree';
}
