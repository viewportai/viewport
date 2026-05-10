import type { Daemon } from '../core/daemon.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { parseWorkflow, parseWorkflowFile } from './parser.js';
import { addEvent, normalizeInputs } from './runtime-helpers.js';
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
import { formatExecutionPolicy, workflowNodeMetadata, type RunnerOps } from './runner-shared.js';
import { runApprovalOnRejectFollowUp } from './approval-on-reject.js';
import { buildWorkflowContractBinding } from './contract-binding.js';
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
      void this.recordWorkflowHookEvent(event).catch(() => undefined);
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
    const resourceManifest = resolveSessionResourceManifestSync({
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
    void this.scheduler.run(run.id, parsed).catch((error) => {
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

  async decideApproval(
    runId: string,
    nodeId: string,
    decision: WorkflowApprovalDecision,
  ): Promise<WorkflowRunRecord> {
    const run = await this.requireRun(runId);
    const state = run.nodes[nodeId];
    if (!state || (state.type !== 'approval' && state.type !== 'gate' && state.type !== 'plan')) {
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
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
    };

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
    state.status = 'completed';
    state.completedAt = resolvedAt;
    const approvalNode = parsed.definition.nodes[nodeId];
    // type=approval defaults to constant 'Approved' output so the reviewer's
    // free-text doesn't accidentally flow into downstream prompts. Authors
    // opt into message capture via `captureResponse: true`.
    // type=gate (human_review) keeps the message as output — gate output is
    // expected to be a free-text payload by design.
    const isOptInApproval =
      approvalNode?.type === 'approval' && approvalNode.captureResponse !== true;
    const planBody =
      state.type === 'plan' &&
      state.metadata &&
      typeof state.metadata['plan'] === 'object' &&
      state.metadata['plan'] !== null &&
      'body' in state.metadata['plan'] &&
      typeof (state.metadata['plan'] as { body?: unknown }).body === 'string'
        ? (state.metadata['plan'] as { body: string }).body
        : null;
    state.output = planBody ?? (isOptInApproval ? 'Approved' : (decision.message ?? 'Approved'));
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

  async cancelRun(runId: string, options: WorkflowCancelOptions = {}): Promise<WorkflowRunRecord> {
    return this.canceler.cancelRun(runId, options);
  }

  private async recordWorkflowHookEvent(event: {
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
  }): Promise<void> {
    const run = await this.store.get(event.workflowRunId);
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
    await this.saveAndEmit(run);
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
