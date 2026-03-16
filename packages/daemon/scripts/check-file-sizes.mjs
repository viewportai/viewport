#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const waiverPath = path.join(repoRoot, '.file-size-waivers.json');

async function listTsFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage') {
        continue;
      }
      files.push(...(await listTsFiles(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

async function loadWaiver() {
  try {
    const raw = await fs.readFile(waiverPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const maxLines = Number(parsed.maxLines) || 400;
    const waived = new Set(Array.isArray(parsed.waived) ? parsed.waived : []);
    return { maxLines, waived };
  } catch {
    return { maxLines: 400, waived: new Set() };
  }
}

async function main() {
  const { maxLines, waived } = await loadWaiver();
  const srcRoot = path.join(repoRoot, 'src');
  const files = await listTsFiles(srcRoot);

  const violations = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file).replaceAll(path.sep, '/');
    const raw = await fs.readFile(file, 'utf-8');
    const lines = raw.split('\n').length;
    if (lines > maxLines && !waived.has(rel)) {
      violations.push({ file: rel, lines });
    }
  }

  if (violations.length === 0) {
    console.log(`File-size guard passed (max ${maxLines} lines).`);
    return;
  }

  console.error(`File-size guard failed (max ${maxLines} lines).`);
  for (const violation of violations) {
    console.error(`  ${violation.file}: ${violation.lines}`);
  }
  console.error('Add explicit waivers in .file-size-waivers.json or split files.');
  process.exit(1);
}

await main();
