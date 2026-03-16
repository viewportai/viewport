#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const protocolPath = path.join(repoRoot, 'src/server/ws-protocol.ts');
const handlersPath = path.join(repoRoot, 'src/server/ws-command-handlers.ts');
const matrixPath = path.join(repoRoot, 'docs/protocol-matrix.json');

function extractSchemaTypes(source) {
  const out = new Set();
  const re = /type:\s*z\.literal\('([a-z-]+)'\)/g;
  for (;;) {
    const m = re.exec(source);
    if (!m) break;
    out.add(m[1]);
  }
  return out;
}

function extractHandlerTypes(source) {
  const out = new Set();
  const re = /^\s+['"]?([a-z-]+)['"]?:\s+async\s+\(/gm;
  for (;;) {
    const m = re.exec(source);
    if (!m) break;
    out.add(m[1]);
  }
  return out;
}

function sort(arr) {
  return [...arr].sort((a, b) => a.localeCompare(b));
}

function diff(a, b) {
  return sort([...a].filter((item) => !b.has(item)));
}

async function pathExists(relPath) {
  try {
    await fs.access(path.join(repoRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [protocolSource, handlersSource, matrixRaw] = await Promise.all([
    fs.readFile(protocolPath, 'utf-8'),
    fs.readFile(handlersPath, 'utf-8'),
    fs.readFile(matrixPath, 'utf-8'),
  ]);

  const matrix = JSON.parse(matrixRaw);
  const messages = Array.isArray(matrix.messages) ? matrix.messages : [];
  const matrixTypes = new Set(messages.map((entry) => entry.type).filter((entry) => typeof entry === 'string'));
  const schemaTypes = extractSchemaTypes(protocolSource);
  const handlerTypes = extractHandlerTypes(handlersSource);

  const missingInMatrix = diff(schemaTypes, matrixTypes);
  const extraInMatrix = diff(matrixTypes, schemaTypes);
  const missingHandlers = diff(schemaTypes, handlerTypes);

  const errors = [];
  if (missingInMatrix.length > 0) {
    errors.push(`Matrix is missing schema message types: ${missingInMatrix.join(', ')}`);
  }
  if (extraInMatrix.length > 0) {
    errors.push(`Matrix contains unknown message types: ${extraInMatrix.join(', ')}`);
  }
  if (missingHandlers.length > 0) {
    errors.push(`Command handlers are missing message types: ${missingHandlers.join(', ')}`);
  }

  const validClasses = new Set(['stable', 'experimental', 'internal']);
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') {
      errors.push('Matrix entries must be objects.');
      continue;
    }
    if (typeof entry.type !== 'string' || entry.type.length === 0) {
      errors.push('Matrix entry has invalid "type".');
    }
    if (!validClasses.has(entry.class)) {
      errors.push(`Matrix entry ${entry.type ?? '<unknown>'} has invalid class: ${String(entry.class)}`);
    }
    if (typeof entry.schema !== 'string' || entry.schema.length === 0) {
      errors.push(`Matrix entry ${entry.type ?? '<unknown>'} is missing schema metadata.`);
    }
    if (typeof entry.handler !== 'string' || entry.handler.length === 0) {
      errors.push(`Matrix entry ${entry.type ?? '<unknown>'} is missing handler metadata.`);
    }
    for (const key of ['unitTests', 'integrationTests']) {
      const tests = entry[key];
      if (!Array.isArray(tests) || tests.length === 0) {
        errors.push(`Matrix entry ${entry.type ?? '<unknown>'} must include non-empty ${key}.`);
        continue;
      }
      for (const relPath of tests) {
        if (typeof relPath !== 'string' || relPath.length === 0) {
          errors.push(`Matrix entry ${entry.type ?? '<unknown>'} has invalid ${key} path.`);
          continue;
        }
        if (!(await pathExists(relPath))) {
          errors.push(`Matrix entry ${entry.type ?? '<unknown>'} references missing file: ${relPath}`);
        }
      }
    }
    if (typeof entry.surfacedInUi !== 'boolean') {
      errors.push(`Matrix entry ${entry.type ?? '<unknown>'} must set surfacedInUi boolean.`);
    }
    if (typeof entry.surfacedInCli !== 'boolean') {
      errors.push(`Matrix entry ${entry.type ?? '<unknown>'} must set surfacedInCli boolean.`);
    }
  }

  if (errors.length > 0) {
    console.error('Protocol matrix drift check failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(`Protocol matrix check passed (${schemaTypes.size} message types).`);
}

await main();
