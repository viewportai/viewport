/**
 * Contract fixture validation against the installed `@viewportai/protocol`
 * package (RT-02 / HARD-02 thin slice).
 *
 * The drift gate (scripts/check-protocol-contracts.mjs) pins the protocol's
 * JSON Schema artifacts byte-for-byte; this suite proves the daemon's actual
 * runtime payloads still satisfy those schemas:
 *   - workflow-run sync: the run record + WS frames built by the real
 *     command handlers validate against the workflow_run* schemas;
 *   - receipt sync: the context receipts carried in the daemon's platform
 *     sync payload validate against viewport.context_receipt/v1;
 *   - run receipt: the protocol's golden sample validates (schema + digest
 *     chain) through the daemon's reusable run-receipt validator.
 *
 * If a protocol bump changes a contract shape, the drift gate forces a
 * deliberate snapshot update and this suite tells you whether the daemon's
 * payloads survived the change.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import { workflowRunToSyncPayload } from '../../src/workflows/platform-sync-payload.js';
import { validateRunReceiptDocument } from '../../src/workflows/run-receipt-validation.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

function findProtocolRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, 'node_modules', '@viewportai', 'protocol');
    if (existsSync(path.join(candidate, 'generated', 'json-schema', 'manifest.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Could not find installed @viewportai/protocol in node_modules');
    }
    current = parent;
  }
}

const protocolRoot = findProtocolRoot(process.cwd());
const manifest = JSON.parse(
  readFileSync(path.join(protocolRoot, 'generated', 'json-schema', 'manifest.json'), 'utf8'),
) as { schemas: Array<{ schemaId: string; jsonSchema: string | null }> };

const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map<string, ValidateFunction>();

function validatorFor(schemaId: string): ValidateFunction {
  const cached = validators.get(schemaId);
  if (cached) return cached;
  const entry = manifest.schemas.find((candidate) => candidate.schemaId === schemaId);
  if (!entry?.jsonSchema) {
    throw new Error(`Installed @viewportai/protocol has no JSON Schema artifact for ${schemaId}`);
  }
  const document = JSON.parse(
    readFileSync(
      path.join(protocolRoot, 'generated', 'json-schema', path.basename(entry.jsonSchema)),
      'utf8',
    ),
  ) as { definitions?: Record<string, object> };
  // The artifacts wrap the schema as { $ref: '#/definitions/<id>' } with an
  // unescaped '/' in the pointer; compile the root definition directly (the
  // platform's generate-protocol-web-contracts.mjs does the same).
  const definition = document.definitions?.[schemaId];
  if (!definition) {
    throw new Error(`Missing root definition for ${schemaId} in ${entry.jsonSchema}`);
  }
  const validate = ajv.compile(definition);
  validators.set(schemaId, validate);
  return validate;
}

function expectValid(schemaId: string, payload: unknown, label: string): void {
  const validate = validatorFor(schemaId);
  const valid = validate(payload);
  expect(
    valid,
    `${label} does not satisfy ${schemaId}: ${ajv.errorsText(validate.errors, { dataVar: label })}`,
  ).toBe(true);
}

function createClient(): { client: ConnectedClient; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const client: ConnectedClient = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
  return { client, sent };
}

function findSentMessage(
  sent: Array<Record<string, unknown>>,
  type: string,
): Record<string, unknown> {
  const message = sent.find((entry) => entry.type === type);
  expect(message, `expected a sent '${type}' frame`).toBeDefined();
  return message as Record<string, unknown>;
}

function createContractWorkflowRun(): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: 'run-contract-1',
    workflowName: 'contract-proof',
    workflowTitle: 'Protocol contract proof',
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://templates/contract-proof',
    digest: `sha256:${'a'.repeat(64)}`,
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: contract-proof\nnodes: {}\n',
    directoryId: 'dir-1',
    directoryPath: '/tmp/viewport-contract-proof',
    resourceId: 'resource-1',
    runtimeTargetId: 'target-1',
    platformRunId: 'platform-run-1',
    machineId: 'machine-1',
    executionPolicy: { mode: 'current_tree' },
    dataCapturePolicy: {
      transcripts: 'excerpt',
      logs: 'metadata',
      artifacts: 'local_reference',
    },
    initiation: 'browser',
    status: 'completed',
    inputs: { focus: 'risk' },
    preflight: { ok: true, issues: [] },
    nodes: {
      inspect: {
        id: 'inspect',
        type: 'shell',
        title: 'Inspect repository',
        status: 'completed',
        startedAt: now - 1_000,
        completedAt: now,
        output: 'Tests passed',
        outputs: { result: 'ok' },
      },
    },
    artifacts: [
      {
        id: 'artifact-1',
        runId: 'run-contract-1',
        nodeId: 'inspect',
        name: 'test-log',
        kind: 'log',
        path: '/tmp/viewport-contract-proof/test.log',
        digest: `sha256:${'b'.repeat(64)}`,
        description: 'Captured test proof',
        sizeBytes: 128,
        createdAt: now,
      },
    ],
    contextReceipts: [
      {
        schema: 'viewport.context_receipt/v1',
        package: 'payments-domain-rules',
        requested: 'payment bug',
        resolvedVersion: 'v1',
        provider: 'repo-docs',
        digest: `sha256:${'c'.repeat(64)}`,
        freshness: 'fresh',
        usedBy: {
          runId: 'run-contract-1',
          nodeId: 'inspect',
          providerId: 'repo-docs',
          itemId: 'item-1',
          alias: null,
          title: 'Payment rules',
        },
        resolvedAt: new Date(now).toISOString(),
      },
    ],
    events: [
      {
        id: 'event-1',
        runId: 'run-contract-1',
        timestamp: now,
        type: 'run-completed',
        nodeId: 'inspect',
        message: 'Workflow completed',
        data: { proof: true },
      },
    ],
    createdAt: now - 2_000,
    startedAt: now - 1_000,
    updatedAt: now,
    completedAt: now,
  };
}

describe('protocol contract fixtures', () => {
  it('workflow-run sync: the daemon run record satisfies viewport.workflow_run_record/v1', () => {
    expectValid('viewport.workflow_run_record/v1', createContractWorkflowRun(), 'run record');
  });

  it('session-event frames: WS frames built by the real handlers satisfy the message schemas', async () => {
    const { client, sent } = createClient();
    const run = createContractWorkflowRun();
    const handlers = createWsCommandHandlers({
      daemon: {
        workflowRunner: {
          startRun: vi.fn().mockResolvedValue(run),
          listRuns: vi.fn().mockResolvedValue([run]),
          getRun: vi.fn().mockResolvedValue(run),
        },
      } as never,
      sendAck: vi.fn(),
      getOrCreateBuffer: vi.fn() as never,
    });

    await handlers['workflow-run'](client, {
      type: 'workflow-run',
      workflowYaml: run.yamlSnapshot,
      directoryId: 'dir-1',
      resourceId: 'resource-1',
      runtimeTargetId: 'target-1',
      platformRunId: 'platform-run-1',
      inputs: { focus: 'risk' },
      requestId: 'req-run-contract',
    });
    expectValid(
      'viewport.workflow_run_started_message/v1',
      findSentMessage(sent, 'workflow-run-started'),
      'workflow-run-started frame',
    );

    await handlers['workflow-list-runs'](client, {
      type: 'workflow-list-runs',
      limit: 25,
      requestId: 'req-list-contract',
    });
    expectValid(
      'viewport.workflow_runs_message/v1',
      findSentMessage(sent, 'workflow-runs'),
      'workflow-runs frame',
    );

    await handlers['workflow-show-run'](client, {
      type: 'workflow-show-run',
      runId: run.id,
      requestId: 'req-show-contract',
    });
    expectValid(
      'viewport.workflow_run_detail_message/v1',
      findSentMessage(sent, 'workflow-run-detail'),
      'workflow-run-detail frame',
    );

    // The updated push uses the same envelope shape as the event bridge
    // (src/server/ws-daemon-event-bridge.ts).
    expectValid(
      'viewport.workflow_run_updated_message/v1',
      { type: 'workflow-run-updated', run },
      'workflow-run-updated frame',
    );
  });

  it('receipt sync: context receipts in the platform sync payload satisfy viewport.context_receipt/v1', () => {
    const run = createContractWorkflowRun();
    const payload = workflowRunToSyncPayload(run, { enforceDataCapturePolicy: true });
    const receipts = payload['context_receipts_snapshot'] as unknown[];
    expect(Array.isArray(receipts)).toBe(true);
    expect(receipts.length).toBeGreaterThan(0);
    for (const [index, receipt] of receipts.entries()) {
      expectValid('viewport.context_receipt/v1', receipt, `context receipt ${index}`);
    }
  });

  it('run receipt: the protocol golden sample passes the daemon validator (schema + digest chain)', () => {
    const golden = parseYaml(
      readFileSync(path.join(protocolRoot, 'samples', 'run-receipt.golden.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    const result = validateRunReceiptDocument(golden);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);

    // And the golden sample also satisfies the generated JSON Schema artifact,
    // so the Zod schema and the artifact agree.
    expectValid('viewport.run_receipt/v1', golden, 'golden run receipt');
  });

  it('run receipt: the daemon validator rejects a tampered digest chain', () => {
    const golden = parseYaml(
      readFileSync(path.join(protocolRoot, 'samples', 'run-receipt.golden.yaml'), 'utf8'),
    ) as { entries: Array<{ summary: Record<string, unknown> }> } & Record<string, unknown>;
    const tampered = structuredClone(golden);
    tampered.entries[0]!.summary['kind'] = 'tampered';
    const result = validateRunReceiptDocument(tampered);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes('entry_digest'))).toBe(true);
  });
});
