import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Daemon } from '../core/daemon.js';
import { parseWorkflow, workflowNodeOrder, parseWorkflowFile } from './parser.js';
import { preflightWorkflow } from './preflight.js';
import { WorkflowRunStore } from './store.js';
import type {
  ParsedWorkflow,
  WorkflowNode,
  WorkflowNodeRunState,
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowRunRequest,
} from './types.js';

const MAX_OUTPUT_CHARS = 32_000;

export class WorkflowRunner {
  private readonly store = new WorkflowRunStore();

  constructor(private readonly daemon: Daemon) {}

  async validateFile(filePath: string): Promise<ParsedWorkflow> {
    return parseWorkflowFile(filePath);
  }

  validateText(sourceText: string, sourceRef = 'viewport://workflow/inline'): ParsedWorkflow {
    return parseWorkflow(sourceText, sourceRef);
  }

  async listRuns(limit?: number): Promise<WorkflowRunRecord[]> {
    return this.store.list(limit);
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    return this.store.get(runId);
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
    const run = await this.requireRun(runId);
    run.status = 'running';
    run.updatedAt = Date.now();
    addEvent(run, 'run-started', 'Workflow run started');
    run.preflight = await preflightWorkflow(parsed.definition, {
      availableAgents: () => this.daemon.getAvailableAgents(),
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
        const output = await runShellNode(node.command, {
          cwd: resolveNodeCwd(run.directoryPath, node.cwd),
          timeoutSeconds: node.timeoutSeconds,
        });
        state.output = output;
        addEvent(run, 'node-output', `Node ${nodeId} produced shell output`, { output }, nodeId);
      } else if (node.type === 'prompt') {
        const prompt = renderTemplate(node.prompt, run.inputs);
        const sessionId = await this.daemon.launchSession(run.directoryId, prompt, {
          ...(node.agent ? { agent: node.agent } : {}),
          ...(node.model ? { model: node.model } : {}),
        });
        state.sessionId = sessionId;
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
        const reason = await waitForSessionEnd(this.daemon, sessionId);
        addEvent(
          run,
          'session-ended',
          `Node ${nodeId} session ${sessionId} ended`,
          { sessionId, reason },
          nodeId,
        );
        if (isFailedSessionReason(reason)) {
          throw new Error(`Session ${sessionId} failed: ${reason}`);
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
    return run;
  }

  private async saveAndEmit(run: WorkflowRunRecord): Promise<void> {
    await this.store.save(run);
    this.daemon.emit('workflow:run-updated', { run });
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

async function waitForSessionEnd(daemon: Daemon, sessionId: string): Promise<string> {
  return await new Promise<string>((resolve) => {
    const handler = (event: { sessionId: string; reason: string }): void => {
      if (event.sessionId !== sessionId) return;
      daemon.off('session:ended', handler);
      resolve(event.reason);
    };
    daemon.on('session:ended', handler);
  });
}

function isFailedSessionReason(reason: string): boolean {
  return /(^|[\s:_-])(error|failed|failure)([\s:_-]|$)/i.test(reason);
}

function normalizeInputs(
  parsed: ParsedWorkflow,
  provided: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, definition] of Object.entries(parsed.definition.inputs ?? {})) {
    const value = provided[key] ?? definition.default;
    if (value === undefined) {
      if (definition.required) {
        throw new Error(`Missing required workflow input: ${key}`);
      }
      continue;
    }
    result[key] = value;
  }
  for (const [key, value] of Object.entries(provided)) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

function addEvent(
  run: WorkflowRunRecord,
  type: WorkflowRunEvent['type'],
  message: string,
  data?: Record<string, unknown>,
  nodeId?: string,
): void {
  run.events.push({
    id: crypto.randomUUID(),
    runId: run.id,
    timestamp: Date.now(),
    type,
    nodeId,
    message,
    data,
  });
}

function resolveNodeCwd(directoryPath: string, cwd?: string): string {
  if (!cwd) return directoryPath;
  return path.isAbsolute(cwd) ? cwd : path.join(directoryPath, cwd);
}

function renderTemplate(
  template: string,
  inputs: Record<string, string | number | boolean>,
): string {
  return template.replace(/\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    const value = inputs[key];
    return value === undefined ? '' : String(value);
  });
}

async function runShellNode(
  command: string,
  options: { cwd: string; timeoutSeconds?: number },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('sh', ['-lc', command], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf-8')}`.slice(-MAX_OUTPUT_CHARS);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`Shell node exited with code ${code}: ${output.trim()}`));
      }
    });

    if (options.timeoutSeconds) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Shell node timed out after ${options.timeoutSeconds}s`));
      }, options.timeoutSeconds * 1000);
    }
  });
}
