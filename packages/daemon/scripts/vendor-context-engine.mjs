#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const daemonRoot = resolve(scriptDir, '..');
const repoRoot = resolve(daemonRoot, '../..');
const sourceRoot = resolve(repoRoot, 'packages/context-engine');
const targetRoot = resolve(daemonRoot, 'node_modules/@viewportai/context-engine');

const command = process.argv[2];

function clean() {
  rmSync(targetRoot, { force: true, recursive: true });
}

function copyPath(path) {
  cpSync(resolve(sourceRoot, path), resolve(targetRoot, path), {
    force: true,
    recursive: true,
  });
}

if (command === 'clean') {
  clean();
  process.exit(0);
}

if (command !== 'prepare') {
  console.error('Usage: node ./scripts/vendor-context-engine.mjs <prepare|clean>');
  process.exit(1);
}

if (!existsSync(sourceRoot)) {
  console.error(`Context engine workspace package not found: ${sourceRoot}`);
  process.exit(1);
}

clean();
mkdirSync(targetRoot, { recursive: true });

for (const path of ['README.md', 'src', 'schemas', 'fixtures']) {
  copyPath(path);
}

const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'));
delete packageJson.dependencies;
delete packageJson.devDependencies;
delete packageJson.scripts;
writeFileSync(resolve(targetRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
