/**
 * Protocol pin drift gate (offline portion).
 *
 * The daemon pins `@viewportai/protocol` and keeps a hand-maintained copy of the
 * policy schema (src/cli/policy-schema-validator.ts) plus a conformance corpus
 * reconciled against a specific protocol version. If the package.json pin and the
 * committed "expected" version (docs/protocol-pin.json) drift apart, the
 * reconciliation can silently rot. This test fails that drift fast and offline.
 *
 * The companion script scripts/check-protocol-pin.mjs additionally checks the
 * pin against the *published* latest over the network in CI.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@viewportai/protocol';

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(daemonRoot, relPath), 'utf-8'));
}

function rangeFloor(range: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(range.trim());
  return m ? m[1] : null;
}

describe('protocol pin drift gate', () => {
  const pkg = readJson('package.json') as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const pin = readJson('docs/protocol-pin.json') as { expected?: string; package?: string };

  const range =
    pkg.dependencies?.[PACKAGE_NAME] ??
    pkg.devDependencies?.[PACKAGE_NAME] ??
    pkg.peerDependencies?.[PACKAGE_NAME];

  it('declares the protocol dependency', () => {
    expect(range, `${PACKAGE_NAME} must be pinned in package.json`).toBeTruthy();
  });

  it('keeps docs/protocol-pin.json targeting the protocol package', () => {
    expect(pin.package).toBe(PACKAGE_NAME);
  });

  it('keeps the package.json pin floor in sync with the committed expected version', () => {
    const floor = rangeFloor(range as string);
    expect(
      floor,
      `Pin range "${range}" floor (${floor}) must equal docs/protocol-pin.json "expected" (${pin.expected}). ` +
        'If a new protocol version shipped, bump BOTH and reconcile policy-schema-validator.ts + the ' +
        'conformance corpus. See scripts/check-protocol-pin.mjs for the full fix steps.',
    ).toBe(pin.expected);
  });
});
