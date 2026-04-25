import type { Daemon } from '../core/daemon.js';
import { parseWorkflow, parseWorkflowFile } from './parser.js';
import { addEvent, normalizeInputs } from './runtime-helpers.js';
import { WorkflowRunPlatformSync } from './platform-sync.js';
import { WorkflowSessionLinkStore } from './session-links.js';
import { WorkflowRunStore } from './store.js';
import { resolveWorkflowSource } from './workflow-source.js';
import { WorkflowLayerScheduler } from './runner-scheduler.js';
import { WorkflowRunResumer } from './runner-resumer.js';
import { WorkflowRunReconciler } from './runner-reconciler.js';
import { formatExecutionPolicy, workflowNodeMetadata, type RunnerOps } from './runner-shared.js';
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
  private readonly scheduler: WorkflowLayerScheduler;
  private readonly resumer: WorkflowRunResumer;
  private readonly reconciler: WorkflowRunReconciler;

  constructor(private readonly daemon: Daemon) {
    this.platformSync = new WorkflowRunPlatformSync(daemon.configManager);

    const ops: RunnerOps = {
      requireRun: (runId) => this.requireRun(runId),
      saveAndEmit: (run) => this.saveAndEmit(run),
      failRun: (runId, message) => this.failRun(runId, message),
    };

    this.reconciler = new WorkflowRunReconciler(this.daemon, this.activeRunIds, ops.saveAndEmit);
    this.scheduler = new WorkflowLayerScheduler(
      this.daemon,
      this.sessionLinks,
      this.activeRunIds,
      ops,
    );
    this.resumer = new WorkflowRunResumer(
      this.store,
      (runId, parsed, options) => this.scheduler.run(runId, parsed, options),
      ops.failRun,
    );
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

  async resumePendingRuns(): Promise<{ resumed: number; failed: number }> {
    return this.resumer.resumePendingRuns();
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
    void this.scheduler.run(run.id, parsed).catch((error) => {
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
    state.output = isOptInApproval ? 'Approved' : (decision.message ?? 'Approved');
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
    return this.reconciler.reconcile(run);
  }

  private async saveAndEmit(run: WorkflowRunRecord): Promise<void> {
    await this.store.save(run);
    this.daemon.emit('workflow:run-updated', { run });
    void this.platformSync.sync(run).catch(() => undefined);
  }
}
