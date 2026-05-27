import type { Daemon } from '../core/daemon.js';
import { createHash } from 'node:crypto';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { parseWorkflow, parseWorkflowFile } from './parser.js';
import { addEvent, normalizeInputs, renderTemplate } from './runtime-helpers.js';
import { WorkflowRunPlatformSync } from './platform-sync.js';
import { WorkflowSessionLinkStore } from './session-links.js';
import { WorkflowRunStore } from './store.js';
import { resolveWorkflowSource } from './workflow-source.js';
import { WorkflowLayerScheduler } from './runner-scheduler.js';
import { WorkflowRunResumer } from './runner-resumer.js';
import { WorkflowRunReconciler } from './runner-reconciler.js';
import { WorkflowRunCanceler, type WorkflowCancelOptions } from './runner-canceler.js';
import { WorkflowShellAbortRegistry } from './shell-abort-registry.js';
import { WorkflowRuntimeCommandApplier } from './platform-command-applier.js';
import { runtimeCommands } from './platform-runtime-command.js';
import { formatExecutionPolicy, workflowNodeMetadata, type RunnerOps } from './runner-shared.js';
import { runApprovalOnRejectFollowUp } from './approval-on-reject.js';
import { buildWorkflowContractBinding } from './contract-binding.js';
import { recordWorkflowHookEvent } from './runner-hook-events.js';
import { runWorkflowDaemonSession } from './daemon-session.js';
import { buildRunPreparation } from './run-preparation.js';
import { resolveWorkflowSessionBudget, resolveWorkflowSessionPolicy } from './session-policy.js';
import type {
  ParsedWorkflow,
  WorkflowApprovalDecision,
  WorkflowNode,
  WorkflowNodeRunState,
  WorkflowRunRecord,
  WorkflowRunRequest,
} from './types.js';

export class WorkflowRunner {
  private readonly store = new WorkflowRunStore();
  private readonly sessionLinks = new WorkflowSessionLinkStore();
  private readonly platformSync: WorkflowRunPlatformSync;
  private readonly activeRunIds = new Set<string>();
  private readonly shellAbortRegistry = new WorkflowShellAbortRegistry();
  private readonly scheduler: WorkflowLayerScheduler;
  private readonly resumer: WorkflowRunResumer;
  private readonly reconciler: WorkflowRunReconciler;
  private readonly canceler: WorkflowRunCanceler;
  private readonly platformCommandApplier: WorkflowRuntimeCommandApplier;

  constructor(private readonly daemon: Daemon) {
    this.platformCommandApplier = new WorkflowRuntimeCommandApplier(
      this.store,
      (runId, nodeId, decision) => this.decideApproval(runId, nodeId, decision),
    );
    this.platformSync = new WorkflowRunPlatformSync(daemon.configManager, undefined, {
      onRuntimeCommand: (command, run) => this.platformCommandApplier.apply(command, run.id),
    });

    const ops: RunnerOps = {
      requireRun: (runId) => this.requireRun(runId),
      saveAndEmit: (run) => this.saveAndEmit(run),
      failRun: (runId, message) => this.failRun(runId, message),
    };

    this.reconciler = new WorkflowRunReconciler(this.daemon, this.activeRunIds, ops.saveAndEmit);
    this.canceler = new WorkflowRunCanceler(
      this.daemon,
      this.activeRunIds,
      this.shellAbortRegistry,
      ops,
    );
    this.scheduler = new WorkflowLayerScheduler(
      this.daemon,
      this.sessionLinks,
      this.shellAbortRegistry,
      this.activeRunIds,
      ops,
    );
    this.resumer = new WorkflowRunResumer(
      this.store,
      (runId, parsed, options) => this.scheduler.run(runId, parsed, options),
      ops.failRun,
      (run) => this.reconciler.reconcile(run),
    );
    this.daemon.on('workflow:hook-fired', (event) => {
      void recordWorkflowHookEvent(this.store, (run) => this.saveAndEmit(run), event).catch(
        () => undefined,
      );
    });
  }

  async validateFile(filePath: string): Promise<ParsedWorkflow> {
    return parseWorkflowFile(filePath);
  }

  validateText(sourceText: string, sourceRef = 'viewport://workflow/inline'): ParsedWorkflow {
    return parseWorkflow(sourceText, sourceRef);
  }

  async listRuns(limit?: number): Promise<WorkflowRunRecord[]> {
    const runs = await this.store.list(limit);
    const reconciled = await Promise.all(runs.map((run) => this.reconciler.reconcile(run)));
    return reconciled;
  }

  async resumePendingRuns(): Promise<{
    resumed: number;
    failed: number;
    platformSyncScheduled: number;
  }> {
    const result = await this.resumer.resumePendingRuns();
    const platformSyncScheduled = await this.schedulePlatformLinkedRuns();
    return { ...result, platformSyncScheduled };
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    const run = await this.store.get(runId);
    return run ? this.reconciler.reconcile(run) : null;
  }

  async startRun(request: WorkflowRunRequest): Promise<WorkflowRunRecord> {
    const directory = this.daemon.directoryManager.get(request.directoryId);
    if (!directory) {
      throw new Error(`Directory not registered: ${request.directoryId}`);
    }

    const parsed = await resolveWorkflowSource(request, directory.path);
    const now = Date.now();
    const resourceId = request.resourceId;
    const runtimeTargetId = request.runtimeTargetId;
    const resourceManifest =
      request.resourceManifest ??
      resolveSessionResourceManifestSync({
        workingDirectory: directory.path,
      });
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
      resourceId,
      resourceManifest,
      workflowContract: buildWorkflowContractBinding(request.workflowContract, parsed.digest),
      workflowAuthorityContract: request.workflowAuthorityContract,
      runtimeTargetId,
      platformRunId: request.platformRunId,
      rerunOfWorkflowRunId: request.rerunOfWorkflowRunId,
      machineId: this.daemon.configManager.getMachineId(),
      executionPolicy: request.executionPolicy,
      dataCapturePolicy: request.dataCapturePolicy ?? {
        transcripts: 'none',
        logs: 'metadata',
        artifacts: 'metadata',
      },
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
    addEvent(run, 'context-manifest-resolved', 'Context manifest resolved for workflow run', {
      manifestDigest: resourceManifest.manifestDigest,
      configSourceCount: resourceManifest.configSources.length,
      providerCount: resourceManifest.contract.contextProviders.length,
      workflowCount: resourceManifest.contract.workflows.length,
      warningCount: resourceManifest.warnings.length,
      conflictCount: resourceManifest.conflicts.length,
    });
    try {
      const { preparation, receipts } = await buildRunPreparation(parsed, run);
      run.runPreparation = preparation;
      addEvent(run, 'run-preparation-completed', 'Run preparation completed', {
        preparation,
        receiptCount: receipts.length,
      });
      for (const receipt of receipts) {
        addEvent(
          run,
          receipt.kind.replaceAll('_', '-') as
            | 'operating-repo-prepared'
            | 'context-source-prepared'
            | 'context-update-target-prepared'
            | 'credential-binding-verified'
            | 'side-effect-prepared',
          receipt.reason,
          { ...receipt },
          receipt.node_id,
        );
      }
    } catch (error) {
      addEvent(run, 'run-preparation-failed', 'Run preparation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (run.executionPolicy) {
      addEvent(
        run,
        'execution-policy-selected',
        `Execution policy selected: ${formatExecutionPolicy(run.executionPolicy)}`,
        { executionPolicy: run.executionPolicy },
      );
    }
    if (run.rerunOfWorkflowRunId) {
      addEvent(
        run,
        'run-rerun-requested',
        'Workflow rerun created from an immutable run snapshot',
        { sourceRunId: run.rerunOfWorkflowRunId },
      );
    }
    await this.store.save(run);
    void this.scheduler
      .run(run.id, parsed, {
        runtimeSecretEnv: sanitizeRuntimeSecretEnv(request.runtimeSecretEnv),
      })
      .catch((error) => {
        void this.failRun(run.id, error instanceof Error ? error.message : String(error));
      });
    return run;
  }

  async rerunRun(sourceRunId: string): Promise<WorkflowRunRecord> {
    const sourceRun = await this.requireRun(sourceRunId);

    return this.startRun({
      workflowYaml: sourceRun.yamlSnapshot,
      workflowSourceRef: sourceRun.sourcePath ?? `viewport://workflow-runs/${sourceRun.id}`,
      directoryId: sourceRun.directoryId,
      inputs: sourceRun.inputs,
      resourceId: sourceRun.resourceId,
      runtimeTargetId: sourceRun.runtimeTargetId,
      executionPolicy: sourceRun.executionPolicy,
      dataCapturePolicy: sourceRun.dataCapturePolicy,
      initiation: 'cli',
      rerunOfWorkflowRunId: sourceRun.id,
    });
  }

  private async revisePlanAfterChangesRequested(
    run: WorkflowRunRecord,
    nodeId: string,
    state: WorkflowNodeRunState,
    decision: WorkflowApprovalDecision,
  ): Promise<void> {
    const parsed = parseWorkflow(run.yamlSnapshot, run.sourcePath ?? `viewport://runs/${run.id}`);
    const node = parsed.definition.nodes[nodeId] as WorkflowNode | undefined;
    if (node?.type !== 'plan') return;

    const revision = node.revision;
    if (revision?.onRequestChanges !== 'revise_with_agent' || !revision.prompt) return;

    const revisedAt = Date.now();
    const revisionPrompt = await renderTemplate(revision.prompt, run);
    const revisionPolicy = resolveWorkflowSessionPolicy({
      executionMode: 'plan',
      timeoutSeconds: revision.timeoutSeconds,
    });
    const budget = resolveWorkflowSessionBudget(parsed.definition.policies?.budget);
    state.status = 'running';

    const result = await runWorkflowDaemonSession(
      {
        daemon: this.daemon,
        sessionLinks: this.sessionLinks,
        saveAndEmit: (candidate) => this.saveAndEmit(candidate),
      },
      {
        run,
        nodeId,
        target: state,
        prompt: revisionPrompt,
        ...(revision.agent ? { agent: revision.agent } : {}),
        ...(revision.model ? { model: revision.model } : {}),
        executionMode: revisionPolicy.executionMode,
        allowedTools: [],
        timeoutSeconds: revisionPolicy.timeoutSeconds,
        ...(budget ? { budget } : {}),
        executionModeDefaulted: false,
        timeoutDefaulted: revisionPolicy.timeoutDefaulted,
      },
    );

    const revisionHistory = Array.isArray(state.metadata?.['revision_history'])
      ? state.metadata['revision_history']
      : [];
    const previousPlan = isRecord(state.metadata?.['plan']) ? state.metadata['plan'] : {};
    const planTitle = typeof previousPlan['title'] === 'string' ? previousPlan['title'] : nodeId;
    state.output = result.output;
    state.status = 'blocked';
    state.error = undefined;
    state.metadata = {
      ...(state.metadata ?? {}),
      revision_history: [
        ...revisionHistory,
        {
          requestedAt: state.approval?.resolvedAt ?? revisedAt,
          revisedAt,
          message: decision.message ?? null,
          actor: decision.actor ?? null,
          sessionId: result.sessionId,
          nativeSessionId: result.nativeSessionId,
          body_sha256: hashString(result.output),
        },
      ],
      plan: {
        ...previousPlan,
        body: result.output,
        revisedAt,
        revisionCount: revisionHistory.length + 1,
      },
    };
    state.approval = {
      prompt: `Approve revised plan: ${planTitle}`,
      requestedAt: revisedAt,
      feedback: {
        previousDecision: 'request_changes',
        message: decision.message ?? null,
        actor: decision.actor ?? null,
      },
    };
    run.status = 'blocked';
    run.error = undefined;
    run.updatedAt = revisedAt;
    addEvent(
      run,
      'plan-revised',
      `Plan node ${nodeId} produced a revised plan after changes were requested`,
      {
        message: decision.message ?? null,
        actor: decision.actor ?? null,
        body_sha256: hashString(result.output),
      },
      nodeId,
    );
    addEvent(
      run,
      'approval-requested',
      `Approval requested for revised plan ${nodeId}`,
      {
        prompt: state.approval.prompt,
      },
      nodeId,
    );
  }

  async decideApproval(
    runId: string,
    nodeId: string,
    decision: WorkflowApprovalDecision,
  ): Promise<WorkflowRunRecord> {
    const run = await this.requireRun(runId);
    const state = run.nodes[nodeId];
    if (
      !state ||
      (state.type !== 'approval' &&
        state.type !== 'gate' &&
        state.type !== 'plan' &&
        state.type !== 'action')
    ) {
      throw new Error(`Workflow approval node not found: ${nodeId}`);
    }
    if (run.status !== 'blocked' || state.status !== 'blocked') {
      throw new Error(`Workflow node is not awaiting approval: ${nodeId}`);
    }
    const currentActionDigest =
      state.type === 'action' && state.metadata && typeof state.metadata['action'] === 'object'
        ? (state.metadata['action'] as { digest?: unknown }).digest
        : undefined;
    if (
      state.type === 'action' &&
      decision.expectedActionDigest &&
      typeof currentActionDigest === 'string' &&
      currentActionDigest !== decision.expectedActionDigest
    ) {
      throw new Error(
        'The proposed action changed before approval. Refresh the run and review it again.',
      );
    }

    const resolvedAt = Date.now();
    state.approval = {
      prompt: state.approval?.prompt ?? 'Approval requested',
      requestedAt: state.approval?.requestedAt ?? resolvedAt,
      resolvedAt,
      approved: decision.approved,
      decision: decision.decision ?? (decision.approved ? 'approve' : 'reject'),
      ...(decision.message ? { message: decision.message } : {}),
      ...(decision.actor ? { actor: decision.actor } : {}),
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
      ...(decision.executionGrant ? { executionGrant: decision.executionGrant } : {}),
    };

    if (
      !decision.approved &&
      state.type === 'plan' &&
      state.approval.decision === 'request_changes'
    ) {
      state.status = 'blocked';
      state.error = undefined;
      run.status = 'blocked';
      run.error = undefined;
      run.updatedAt = resolvedAt;
      addEvent(
        run,
        'approval-resolved',
        `Changes requested for node ${nodeId}`,
        { ...decision },
        nodeId,
      );
      addEvent(
        run,
        'plan-changes-requested',
        `Plan changes requested for node ${nodeId}; waiting for a revised plan`,
        {
          decision: 'request_changes',
          message: decision.message ?? null,
          actor: decision.actor ?? null,
          feedback: decision.feedback ?? null,
        },
        nodeId,
      );
      await this.revisePlanAfterChangesRequested(run, nodeId, state, decision);
      await this.saveAndEmit(run);
      return run;
    }

    if (!decision.approved) {
      // Run the approval node's onReject command if declared. Failures here
      // are recorded but never block the rejection — the run is canceling
      // anyway. The approver's free-text rejection message is exposed via
      // VIEWPORT_REJECT_MESSAGE so scripts can react to it.
      const parsedForReject = parseWorkflow(
        run.yamlSnapshot,
        run.sourcePath ?? `viewport://runs/${run.id}`,
      );
      const rejectingNode = parsedForReject.definition.nodes[nodeId];
      if (rejectingNode?.type === 'approval' && rejectingNode.onReject) {
        await runApprovalOnRejectFollowUp(
          {
            daemon: this.daemon,
            sessionLinks: this.sessionLinks,
            shellAbortRegistry: this.shellAbortRegistry,
            saveAndEmit: (nextRun) => this.saveAndEmit(nextRun),
          },
          run,
          nodeId,
          rejectingNode.onReject,
          decision.message,
        );
      }
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
      addEvent(run, 'run-canceled', `Workflow canceled by approval gate: ${nodeId}`);
      await this.saveAndEmit(run);
      return run;
    }

    const parsed = parseWorkflow(run.yamlSnapshot, run.sourcePath ?? `viewport://runs/${run.id}`);
    const approvalNode = parsed.definition.nodes[nodeId];
    if (approvalNode?.type === 'action') {
      state.status = 'queued';
      state.completedAt = undefined;
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
      await this.saveAndEmit(run);

      void this.scheduler.run(run.id, parsed, { resumed: true }).catch((error) => {
        void this.failRun(run.id, error instanceof Error ? error.message : String(error));
      });
      return run;
    }

    state.status = 'completed';
    state.completedAt = resolvedAt;
    // type=approval defaults to constant 'Approved' output so the reviewer's
    // free-text doesn't accidentally flow into downstream prompts. Authors
    // opt into message capture via `captureResponse: true`.
    // type=gate (human_review) keeps the message as output — gate output is
    // expected to be a free-text payload by design.
    const isOptInApproval =
      approvalNode?.type === 'approval' && approvalNode.captureResponse !== true;
    const commandPlanBody =
      state.type === 'plan' &&
      decision.feedback &&
      typeof decision.feedback['plan_body'] === 'string'
        ? decision.feedback['plan_body']
        : null;
    const planBody =
      state.type === 'plan' &&
      state.metadata &&
      typeof state.metadata['plan'] === 'object' &&
      state.metadata['plan'] !== null &&
      'body' in state.metadata['plan'] &&
      typeof (state.metadata['plan'] as { body?: unknown }).body === 'string'
        ? (state.metadata['plan'] as { body: string }).body
        : null;
    state.output =
      commandPlanBody ??
      planBody ??
      (isOptInApproval ? 'Approved' : (decision.message ?? 'Approved'));
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

    void this.scheduler.run(run.id, parsed, { resumed: true }).catch((error) => {
      void this.failRun(run.id, error instanceof Error ? error.message : String(error));
    });
    return run;
  }

  async applyRuntimeCommandBody(runId: string, body: unknown): Promise<number> {
    const run = await this.getRun(runId);
    if (!run) return 0;

    let applied = 0;
    for (const command of runtimeCommands(body)) {
      if (await this.platformCommandApplier.apply(command, run.id)) {
        applied += 1;
      }
    }

    return applied;
  }

  async cancelRun(runId: string, options: WorkflowCancelOptions = {}): Promise<WorkflowRunRecord> {
    return this.canceler.cancelRun(runId, options);
  }

  private async failRun(runId: string, message: string): Promise<void> {
    const run = await this.getRun(runId);
    if (
      !run ||
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'canceled'
    ) {
      return;
    }
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
    return this.reconciler.reconcile(run);
  }

  private async saveAndEmit(run: WorkflowRunRecord): Promise<void> {
    await this.store.save(run);
    this.daemon.emit('workflow:run-updated', { run });
    this.platformSync.schedule(run);
  }

  private async schedulePlatformLinkedRuns(): Promise<number> {
    let scheduled = 0;
    for (const run of await this.store.list(500)) {
      if (!run.resourceId || !run.runtimeTargetId || !run.platformRunId) continue;
      this.platformSync.schedule(run);
      scheduled += 1;
    }
    return scheduled;
  }
}

function sanitizeRuntimeSecretEnv(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, secret]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && secret.length > 0,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
