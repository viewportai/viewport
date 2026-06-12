#!/usr/bin/env node
/**
 * Protocol CONTRACT drift gate (RT-02).
 *
 * `check:protocol-pin` guards the dependency *version*; this gate guards the
 * contract *content*. It pins the daemon's runtime contract surface — the
 * workflow-run sync record, the WebSocket workflow-run frames pushed to
 * clients, the receipt-sync shapes, and the runtime run-sync payload — to the
 * exact JSON Schema artifacts shipped inside the installed
 * `@viewportai/protocol` package, plus the conformance corpora the daemon's
 * copied schemas are validated against.
 *
 * How it works (generate-or-validate, mirroring the platform's
 * `protocol:check-web-contracts` gate):
 *   - A committed snapshot (docs/protocol-contract.json) records the protocol
 *     version and a sha256 digest per surface schema artifact + corpus file.
 *   - Default mode recomputes everything from node_modules and FAILS (exit 1)
 *     on any difference: a protocol bump, a regenerated schema artifact, or a
 *     missing surface schema. Every protocol change therefore becomes a
 *     deliberate commit that re-runs the daemon's contract fixture tests
 *     (tests/contracts/protocol-contracts.test.ts), never a silent lockfile
 *     float.
 *
 * To update after a deliberate protocol bump:
 *   1. `npm install` the new @viewportai/protocol at the workspace root.
 *   2. `node ./scripts/check-protocol-contracts.mjs --update`
 *   3. Re-run the daemon suite (the conformance + contract fixture tests must
 *      pass against the new artifacts) and commit the snapshot diff together
 *      with the lockfile bump.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonRoot = path.resolve(new URL('..', import.meta.url).pathname);
const snapshotPath = path.join(daemonRoot, 'docs/protocol-contract.json');

const PACKAGE_NAME = '@viewportai/protocol';

/**
 * The daemon's contract surface: every schema id here describes a payload
 * shape the daemon produces or consumes at runtime.
 */
const SURFACE_SCHEMA_IDS = [
  // Workflow-run sync: the canonical run record projection shared by
  // daemon, platform, and web.
  'viewport.workflow_run_record/v1',
  // Session-event frames: the daemon WebSocket envelopes pushed to clients.
  'viewport.workflow_runs_message/v1',
  'viewport.workflow_run_started_message/v1',
  'viewport.workflow_run_updated_message/v1',
  'viewport.workflow_run_detail_message/v1',
  // Receipt sync: the receipt shapes carried by the daemon's sync payloads
  // and the canonical exportable run receipt.
  'viewport.run_receipt/v1',
  'viewport.execution_receipt/v1',
  'viewport.audit_receipt/v1',
  'viewport.context_receipt/v1',
  // Runtime run-sync payload (worker runtime <-> control plane).
  'viewport.runtime.run_sync_payload/v2',
];

/** Conformance corpora validated by the daemon's schema-copy tests. */
const CORPUS_FILES = ['fixtures/policy-conformance-corpus.json', 'fixtures/agent-conformance-corpus.json'];

function sha256(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function fail(lines) {
  console.error('Protocol contract drift check FAILED:');
  for (const line of lines) console.error(`  - ${line}`);
  console.error('');
  console.error('If this protocol change is deliberate:');
  console.error('  1. node packages/daemon/scripts/check-protocol-contracts.mjs --update');
  console.error('  2. re-run the daemon suite (contract fixture + conformance tests) and');
  console.error('     commit the docs/protocol-contract.json diff with the dependency bump.');
  process.exit(1);
}

async function computeCurrent() {
  // The package is ESM-only and its exports map hides package.json; resolve
  // the main entry (<root>/dist/index.js) via import resolution and walk up
  // to the package root.
  const mainEntry = fileURLToPath(import.meta.resolve(PACKAGE_NAME));
  const protocolRoot = path.dirname(path.dirname(mainEntry));
  const pkg = JSON.parse(await fs.readFile(path.join(protocolRoot, 'package.json'), 'utf-8'));

  const manifestPath = path.join(protocolRoot, 'generated/json-schema/manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  const entries = new Map((manifest.schemas ?? []).map((entry) => [entry.schemaId, entry]));

  const schemas = {};
  const problems = [];
  for (const schemaId of SURFACE_SCHEMA_IDS) {
    const entry = entries.get(schemaId);
    if (!entry) {
      problems.push(`Installed ${PACKAGE_NAME}@${pkg.version} no longer lists ${schemaId} in its manifest.`);
      continue;
    }
    if (!entry.jsonSchema) {
      problems.push(`Installed ${PACKAGE_NAME}@${pkg.version} has no JSON Schema artifact for ${schemaId}.`);
      continue;
    }
    const schemaFile = path.join(protocolRoot, 'generated/json-schema', path.basename(entry.jsonSchema));
    schemas[schemaId] = sha256(await fs.readFile(schemaFile));
  }

  const corpora = {};
  for (const relPath of CORPUS_FILES) {
    try {
      corpora[relPath] = sha256(await fs.readFile(path.join(protocolRoot, relPath)));
    } catch {
      problems.push(`Installed ${PACKAGE_NAME}@${pkg.version} is missing corpus file ${relPath}.`);
    }
  }

  return { version: pkg.version, schemas, corpora, problems };
}

async function main() {
  const update = process.argv.includes('--update');
  const current = await computeCurrent();

  if (current.problems.length > 0) {
    fail(current.problems);
  }

  const snapshotDoc = {
    description:
      'Committed snapshot of the daemon-facing @viewportai/protocol contract surface. ' +
      'Regenerate with: node packages/daemon/scripts/check-protocol-contracts.mjs --update',
    protocolVersion: current.version,
    schemas: current.schemas,
    conformanceCorpora: current.corpora,
  };

  if (update) {
    await fs.writeFile(snapshotPath, `${JSON.stringify(snapshotDoc, null, 2)}\n`, 'utf-8');
    console.log(`Protocol contract snapshot updated for ${PACKAGE_NAME}@${current.version} (${snapshotPath}).`);
    return;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf-8'));
  } catch {
    fail([`Missing or unreadable snapshot ${snapshotPath}. Run with --update to create it.`]);
  }

  const reasons = [];
  if (snapshot.protocolVersion !== current.version) {
    reasons.push(
      `Installed ${PACKAGE_NAME}@${current.version} != snapshot protocolVersion ${snapshot.protocolVersion}.`,
    );
  }
  for (const schemaId of SURFACE_SCHEMA_IDS) {
    const expected = snapshot.schemas?.[schemaId];
    const actual = current.schemas[schemaId];
    if (!expected) {
      reasons.push(`Snapshot is missing surface schema ${schemaId}.`);
    } else if (expected !== actual) {
      reasons.push(`Schema artifact drifted for ${schemaId} (snapshot ${expected} != installed ${actual}).`);
    }
  }
  for (const relPath of CORPUS_FILES) {
    const expected = snapshot.conformanceCorpora?.[relPath];
    const actual = current.corpora[relPath];
    if (!expected) {
      reasons.push(`Snapshot is missing conformance corpus digest for ${relPath}.`);
    } else if (expected !== actual) {
      reasons.push(`Conformance corpus drifted: ${relPath} (snapshot ${expected} != installed ${actual}).`);
    }
  }

  if (reasons.length > 0) {
    fail(reasons);
  }

  console.log(
    `Protocol contract check passed (${PACKAGE_NAME}@${current.version}, ` +
      `${Object.keys(current.schemas).length} surface schemas, ${CORPUS_FILES.length} corpora).`,
  );
}

await main();
