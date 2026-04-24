import path from 'node:path';
import type { Daemon } from '../core/daemon.js';
import type { SessionMessage } from '../core/types.js';
import { parseWorkflow, workflowNodeOrder, parseWorkflowFile } from './parser.js';
import { preflightWorkflow } from './preflight.js';
import {
  addEvent,
  normalizeInputs,
  renderOptionalTemplate,
  renderTemplate,
  resolveNodeCwd,
  runShellNode,
} from './runtime-helpers.js';
import {
  getSessionState,
  isFailedSessionReason,
  readReplaySessionState,
  waitForPromptSessionComplete,
} from './session-completion.js';
import {
  createSessionOutputCollector,
  readCodexWorktreeSessionOutput,
  readPersistedSessionOutput,
} from './session-output.js';
import { WorkflowRunStore } from './store.js';
import type {
  ParsedWorkflow,
  WorkflowNode,
  WorkflowNodeRunState,
  WorkflowRunRecord,
  WorkflowRunRequest,
} from './types.js';

export class WorkflowRunner {
  private readonly store = new WorkflowRunStore();
  private readonly activeRunIds = new Set<string>();

  constructor(private readonly daemon: Daemon) {}

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

    const parsed = await this.resolveWorkflow(request, directory.path);
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
      machineId: this.daemon.configManager.getMachineId(),
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
          } satisfies WorkflowNodeRunState,
        ]),
      ),
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    addEvent(run, 'run-created', 'Workflow run created');
    await this.store.save(run);
    void this.executeRun(run.id, parsed).catch((error) => {
      void this.failRun(run.id, error instanceof Error ? error.message : String(error));
    });
    return run;
  }

  private async executeRun(runId: string, parsed: ParsedWorkflow): Promise<void> {
    this.activeRunIds.add(runId);
    try {
      const run = await this.requireRun(runId);
      run.status = 'running';
      run.updatedAt = Date.now();
      addEvent(run, 'run-started', 'Workflow run started');
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
        const node = parsed.definition.nodes[nodeId];
        if (!node) continue;
        await this.executeNode(freshRun, nodeId, node);
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

  private async executeNode(
    run: WorkflowRunRecord,
    nodeId: string,
    node: WorkflowNode,
  ): Promise<void> {
    const state = run.nodes[nodeId];
    if (!state) return;

    state.status = 'running';
    state.startedAt = Date.now();
    run.updatedAt = state.startedAt;
    addEvent(run, 'node-started', `Node ${nodeId} started`, undefined, nodeId);
    await this.saveAndEmit(run);

    try {
      if (node.type === 'shell') {
        const output = await runShellNode(renderTemplate(node.command, run), {
          cwd: resolveNodeCwd(run.directoryPath, renderOptionalTemplate(node.cwd, run)),
          timeoutSeconds: node.timeoutSeconds,
        });
        state.output = output;
        addEvent(run, 'node-output', `Node ${nodeId} produced shell output`, { output }, nodeId);
      } else if (node.type === 'prompt') {
        const prompt = renderTemplate(node.prompt, run);
        const output = createSessionOutputCollector();
        const messageHandler = (event: { sessionId: string; message: SessionMessage }): void => {
          if (event.sessionId !== state.sessionId) return;
          output.push(event.message);
        };
        this.daemon.on('session:message', messageHandler);
        const sessionId = await this.daemon.launchSession(run.directoryId, prompt, {
          ...(node.agent ? { agent: node.agent } : {}),
          ...(node.model ? { model: node.model } : {}),
        });
        state.sessionId = sessionId;
        state.worktreePath = this.readActiveSessionWorktreePath(sessionId);
        addEvent(
          run,
          'session-started',
          `Node ${nodeId} started session ${sessionId}`,
          {
            sessionId,
          },
          nodeId,
        );
        run.updatedAt = Date.now();
        await this.saveAndEmit(run);
        try {
          const reason = await waitForPromptSessionComplete(this.daemon, sessionId);
          state.output = output.text() || state.output;
          const eventType = reason === 'idle' ? 'session-idle' : 'session-ended';
          addEvent(
            run,
            eventType,
            `Node ${nodeId} session ${sessionId} ${reason === 'idle' ? 'became idle' : 'ended'}`,
            { sessionId, reason },
            nodeId,
          );
          if (isFailedSessionReason(reason)) {
            throw new Error(`Session ${sessionId} failed: ${reason}`);
          }
        } finally {
          this.daemon.off('session:message', messageHandler);
        }
      } else {
        throw new Error(`Unsupported executable node type: ${node.type}`);
      }

      state.status = 'completed';
      state.completedAt = Date.now();
      run.updatedAt = state.completedAt;
      addEvent(run, 'node-completed', `Node ${nodeId} completed`, undefined, nodeId);
      await this.saveAndEmit(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.status = 'failed';
      state.error = message;
      state.completedAt = Date.now();
      run.status = 'failed';
      run.error = message;
      run.completedAt = state.completedAt;
      run.updatedAt = state.completedAt;
      addEvent(run, 'node-failed', `Node ${nodeId} failed: ${message}`, undefined, nodeId);
      addEvent(run, 'run-failed', `Workflow run failed: ${message}`);
      await this.saveAndEmit(run);
      throw error;
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
        node.output = node.output || (await this.readPromptNodeOutput(run, node));
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
      const output = await this.readPromptNodeOutput(run, node);
      if (!output) continue;
      node.output = output;
      run.updatedAt = Date.now();
      addEvent(run, 'node-output', `Node ${node.id} recovered prompt output`, { output }, node.id);
      changed = true;
    }

    if (changed) {
      await this.saveAndEmit(run);
    }

    return run;
  }

  private async readPromptNodeOutput(
    run: WorkflowRunRecord,
    node: WorkflowNodeRunState,
  ): Promise<string> {
    if (!node.sessionId) return '';

    const persisted = readPersistedSessionOutput(node.sessionId);
    if (persisted) return persisted;

    const worktreePath = node.worktreePath ?? this.defaultWorktreePath(run, node.sessionId);
    if (!worktreePath) return '';

    try {
      return await readCodexWorktreeSessionOutput(worktreePath);
    } catch {
      return '';
    }
  }

  private readActiveSessionWorktreePath(sessionId: string): string | undefined {
    try {
      return this.daemon.getSessionWorktreePath(sessionId);
    } catch {
      return undefined;
    }
  }

  private defaultWorktreePath(run: WorkflowRunRecord, sessionId: string): string {
    return path.join(run.directoryPath, '.viewport', 'worktrees', sessionId);
  }

  private async resolveWorkflow(
    request: WorkflowRunRequest,
    directoryPath: string,
  ): Promise<ParsedWorkflow> {
    if (request.workflowYaml) {
      return parseWorkflow(
        request.workflowYaml,
        request.workflowSourceRef?.trim() || 'viewport://workflow/inline',
      );
    }

    if (!request.workflowPath) {
      throw new Error('Workflow run requires a workflow file path or YAML snapshot');
    }

    const workflowPath = path.isAbsolute(request.workflowPath)
      ? request.workflowPath
      : path.join(directoryPath, request.workflowPath);
    return parseWorkflowFile(workflowPath);
  }
}
