import type { Daemon } from '../core/daemon.js';
import {
  buildExpressionContext,
  evaluateConditionExpression,
  WorkflowExpressionError,
} from './expression.js';
import { executeWorkflowNode } from './node-executor.js';
import { WorkflowPlatformContextClient } from './platform-context-client.js';
import { preflightWorkflow } from './preflight.js';
import { addEvent } from './runtime-helpers.js';
import type { WorkflowShellAbortRegistry } from './shell-abort-registry.js';
import { captureNodeStructuredOutputs } from './structured-outputs.js';
import {
  evaluateTriggerRule,
  isTriggerSkipReason,
  type TriggerEvaluation,
} from './trigger-rule.js';
import type { WorkflowSessionLinkStore } from './session-links.js';
import { findReadyNodeIds, type RunnerOps } from './runner-shared.js';
import type { ParsedWorkflow, WorkflowRunRecord } from './types.js';

/**
 * Runs the layer-by-layer scheduling loop for an active workflow run. Within
 * a layer, every node whose `needs` are all terminal runs in parallel via
 * `Promise.allSettled`. The scheduler is responsible for run-level status
 * decisions; the executor only mutates per-node state.
 */
export class WorkflowLayerScheduler {
  private readonly platformContextClient: WorkflowPlatformContextClient;

  constructor(
    private readonly daemon: Daemon,
    private readonly sessionLinks: WorkflowSessionLinkStore,
    private readonly shellAbortRegistry: WorkflowShellAbortRegistry,
    private readonly activeRunIds: Set<string>,
    private readonly ops: RunnerOps,
  ) {
    this.platformContextClient = new WorkflowPlatformContextClient(this.daemon.configManager);
  }

  async run(
    runId: string,
    parsed: ParsedWorkflow,
    options: { resumed?: boolean; runtimeSecretEnv?: Record<string, string> } = {},
  ): Promise<void> {
    this.activeRunIds.add(runId);
    try {
      const run = await this.ops.requireRun(runId);
      const startedAt = Date.now();
      run.status = 'running';
      run.startedAt ??= startedAt;
      run.updatedAt = startedAt;
      addEvent(
        run,
        'run-started',
        options.resumed ? 'Workflow run resumed' : 'Workflow run started',
      );
      run.preflight = await preflightWorkflow(parsed.definition, {
        availableAgents: () => this.daemon.getAvailableAgents(),
        availableModels: () => this.daemon.getAvailableModels(),
        directoryPath: run.directoryPath,
      });

      if (!run.preflight.ok) {
        run.status = 'blocked';
        run.completedAt = Date.now();
        run.updatedAt = run.completedAt;
        addEvent(run, 'run-blocked', 'Workflow blocked by preflight', {
          issues: run.preflight.issues,
        });
        await this.ops.saveAndEmit(run);
        return;
      }

      await this.ops.saveAndEmit(run);

      let safety = 0;
      while (true) {
        if (++safety > 10_000) {
          throw new Error('Workflow runner aborted: scheduling loop exceeded safety bound');
        }

        const freshRun = await this.ops.requireRun(runId);
        if (freshRun.status !== 'running') return;

        const ready = findReadyNodeIds(freshRun, parsed);
        if (ready.length === 0) {
          // No more ready nodes. Either everything is terminal (run completes)
          // or some nodes are blocked / orphaned (run pauses or fails).
          break;
        }

        const layer = await this.classifyLayer(freshRun, parsed, ready);

        // Apply the skips synchronously before launching the executable subset.
        for (const skip of layer.skipped) {
          this.markSkipped(freshRun, skip.nodeId, skip.reason);
        }
        if (layer.skipped.length > 0) await this.ops.saveAndEmit(freshRun);

        if (layer.toExecute.length === 0) {
          // Nothing executable in this layer. Loop and try the next.
          continue;
        }

        const results = await Promise.allSettled(
          layer.toExecute.map(async (nodeId) => {
            const node = parsed.definition.nodes[nodeId];
            if (!node) return { nodeId, status: 'noop' as const };
            const state = freshRun.nodes[nodeId];
            if (!state || state.status === 'completed' || state.status === 'skipped') {
              return { nodeId, status: 'noop' as const };
            }
            const outcome = await executeWorkflowNode(
              {
                daemon: this.daemon,
                sessionLinks: this.sessionLinks,
                shellAbortRegistry: this.shellAbortRegistry,
                runtimeSecretEnv: options.runtimeSecretEnv ?? {},
                platformContextClient: this.platformContextClient,
                saveAndEmit: (nextRun) => this.ops.saveAndEmit(nextRun),
              },
              freshRun,
              nodeId,
              node,
            );
            return { nodeId, status: outcome };
          }),
        );

        const updated = await this.ops.requireRun(runId);
        for (const result of results) {
          if (result.status === 'rejected') {
            // executeWorkflowNode rejects after writing the failure on the
            // node state — but if anything ever rejects without that path
            // running first, we still want a trace on the timeline.
            const reason =
              result.reason instanceof Error ? result.reason.message : String(result.reason);
            addEvent(
              updated,
              'run-failed',
              `Layer task rejected without node-level handling: ${reason}`,
              { reason },
            );
            continue;
          }
          const nodeId = result.value.nodeId;
          const node = parsed.definition.nodes[nodeId];
          const state = updated.nodes[nodeId];
          if (state?.status === 'completed' && node) {
            await captureNodeStructuredOutputs(state, node);
          }
        }
        await this.ops.saveAndEmit(updated);

        // Decide run-level status based on the layer's outcome.
        const refreshed = await this.ops.requireRun(runId);
        const layerFailures = layer.toExecute
          .map((nodeId) => ({ nodeId, state: refreshed.nodes[nodeId] }))
          .filter(({ state }) => state?.status === 'failed');
        const layerBlocked = layer.toExecute.some(
          (nodeId) => refreshed.nodes[nodeId]?.status === 'blocked',
        );

        if (layerFailures.length > 0) {
          const haltOn = layerFailures.find(({ nodeId }) => {
            const policy = parsed.definition.nodes[nodeId]?.policy?.onFailure ?? 'halt';
            return policy === 'halt';
          });
          if (haltOn) {
            const message = haltOn.state?.error ?? `Node ${haltOn.nodeId} failed`;
            refreshed.status = 'failed';
            refreshed.error = message;
            refreshed.completedAt = Date.now();
            refreshed.updatedAt = refreshed.completedAt;
            addEvent(refreshed, 'run-failed', `Workflow run failed: ${message}`);
            await this.ops.saveAndEmit(refreshed);
            return;
          }
        }

        if (layerBlocked) {
          // Approval / schedule gate is pending. The run record's status was
          // already set to 'blocked' by the executor; we just stop scheduling.
          return;
        }
      }

      const complete = await this.ops.requireRun(runId);
      if (complete.status !== 'running') return;
      complete.status = 'completed';
      complete.completedAt = Date.now();
      complete.updatedAt = complete.completedAt;
      addEvent(complete, 'run-completed', 'Workflow run completed');
      await this.ops.saveAndEmit(complete);
    } finally {
      this.activeRunIds.delete(runId);
    }
  }

  /**
   * Decide which of the given ready node ids should actually run vs. be
   * skipped. Returns the partition; the runner applies each side.
   */
  private async classifyLayer(
    run: WorkflowRunRecord,
    parsed: ParsedWorkflow,
    nodeIds: string[],
  ): Promise<{
    toExecute: string[];
    skipped: Array<{ nodeId: string; reason: string }>;
  }> {
    const toExecute: string[] = [];
    const skipped: Array<{ nodeId: string; reason: string }> = [];
    for (const nodeId of nodeIds) {
      const node = parsed.definition.nodes[nodeId];
      if (!node) continue;
      const reason = await this.evaluateNodeGuards(run, nodeId, node);
      if (reason) skipped.push({ nodeId, reason });
      else toExecute.push(nodeId);
    }
    return { toExecute, skipped };
  }

  /**
   * Decide whether this node should be skipped based on its `when:` expression
   * and `triggerRule`. Returns a reason string if the node must be skipped, or
   * null if the node should run.
   */
  private async evaluateNodeGuards(
    run: WorkflowRunRecord,
    nodeId: string,
    node: ParsedWorkflow['definition']['nodes'][string],
  ): Promise<string | null> {
    const parents = (node.needs ?? [])
      .map((parentId) => run.nodes[parentId])
      .filter((parent): parent is NonNullable<typeof parent> => Boolean(parent));

    const trigger: TriggerEvaluation = evaluateTriggerRule(node.triggerRule, parents);
    if (!trigger.ready && trigger.reason && isTriggerSkipReason(trigger.reason)) {
      return trigger.reason;
    }

    if (node.when) {
      const context = buildExpressionContext(run);
      try {
        const truthy = await evaluateConditionExpression(node.when, context);
        if (!truthy) return `when: ${node.when} → false`;
      } catch (error) {
        if (error instanceof WorkflowExpressionError) {
          throw new Error(`Invalid when expression on ${nodeId}: ${error.message}`);
        }
        throw error;
      }
    }

    return null;
  }

  private markSkipped(run: WorkflowRunRecord, nodeId: string, reason: string): void {
    const state = run.nodes[nodeId];
    if (!state) return;
    state.status = 'skipped';
    state.skipReason = reason;
    state.completedAt = Date.now();
    run.updatedAt = state.completedAt;
    addEvent(run, 'node-skipped', `Node ${nodeId} skipped: ${reason}`, { reason }, nodeId);
  }
}
