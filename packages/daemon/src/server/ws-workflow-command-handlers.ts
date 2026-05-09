import type { Daemon } from '../core/daemon.js';
import { ErrorCodes } from '../core/error-codes.js';
import type { AckSender } from './ws-command-handlers.js';
import type { IncomingMessage } from './ws-protocol.js';
import type { ConnectedClient } from './hello-builder.js';

type WorkflowMessageType =
  | 'workflow-run'
  | 'workflow-list-runs'
  | 'workflow-show-run'
  | 'workflow-approve'
  | 'workflow-cancel';

type IncomingByType<T extends IncomingMessage['type']> = Extract<IncomingMessage, { type: T }>;

type WorkflowHandlerMap = {
  [K in WorkflowMessageType]: (client: ConnectedClient, msg: IncomingByType<K>) => Promise<void>;
};

export function createWsWorkflowCommandHandlers(ctx: {
  daemon: Daemon;
  sendAck: AckSender;
}): WorkflowHandlerMap {
  const { daemon, sendAck } = ctx;

  return {
    'workflow-run': async (client, msg) => {
      const run = await daemon.workflowRunner.startRun({
        workflowPath: msg.workflowPath,
        workflowYaml: msg.workflowYaml,
        workflowSourceRef: msg.workflowSourceRef,
        directoryId: msg.directoryId,
        inputs: msg.inputs,
        resourceId: msg.resourceId,
        runtimeTargetId: msg.runtimeTargetId,
        platformRunId: msg.platformRunId,
        rerunOfWorkflowRunId: msg.rerunOfWorkflowRunId,
        executionPolicy: msg.executionPolicy,
        dataCapturePolicy: msg.dataCapturePolicy,
        initiation: 'browser',
      });
      client.send(JSON.stringify({ type: 'workflow-run-started', run }));
      sendAck(client, msg.requestId, 'ok', undefined, { runId: run.id });
    },

    'workflow-list-runs': async (client, msg) => {
      const runs = await daemon.workflowRunner.listRuns(msg.limit);
      client.send(JSON.stringify({ type: 'workflow-runs', runs }));
      sendAck(client, msg.requestId, 'ok');
    },

    'workflow-show-run': async (client, msg) => {
      const run = await daemon.workflowRunner.getRun(msg.runId);
      if (!run) {
        sendAck(client, msg.requestId, 'error', `Workflow run not found: ${msg.runId}`, {
          errorCode: ErrorCodes.INVALID_INPUT,
        });
        return;
      }
      client.send(JSON.stringify({ type: 'workflow-run-detail', run }));
      sendAck(client, msg.requestId, 'ok');
    },

    'workflow-approve': async (client, msg) => {
      try {
        const run = await daemon.workflowRunner.decideApproval(msg.runId, msg.nodeId, {
          approved: msg.approved,
          ...(msg.message ? { message: msg.message } : {}),
          ...(msg.actor ? { actor: msg.actor } : {}),
        });
        client.send(JSON.stringify({ type: 'workflow-run-detail', run }));
        sendAck(client, msg.requestId, 'ok', undefined, { runId: run.id, nodeId: msg.nodeId });
      } catch (error) {
        sendAck(
          client,
          msg.requestId,
          'error',
          error instanceof Error ? error.message : 'Failed to resolve workflow approval',
          { errorCode: ErrorCodes.INVALID_INPUT },
        );
      }
    },

    'workflow-cancel': async (client, msg) => {
      try {
        const run = await daemon.workflowRunner.cancelRun(msg.runId, {
          ...(msg.message ? { message: msg.message } : {}),
          ...(msg.actor ? { actor: msg.actor } : {}),
        });
        client.send(JSON.stringify({ type: 'workflow-run-detail', run }));
        sendAck(client, msg.requestId, 'ok', undefined, { runId: run.id });
      } catch (error) {
        sendAck(
          client,
          msg.requestId,
          'error',
          error instanceof Error ? error.message : 'Failed to cancel workflow run',
          { errorCode: ErrorCodes.INVALID_INPUT },
        );
      }
    },
  };
}
