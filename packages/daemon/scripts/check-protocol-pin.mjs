#!/usr/bin/env node
/**
 * Protocol pin drift gate.
 *
 * Fails CI if the daemon's `@viewportai/protocol` dependency pin falls behind
 * the published latest minor/major, or if the pin and the committed "expected"
 * version (docs/protocol-pin.json) have silently desynced.
 *
 * Two checks:
 *   1. OFFLINE (always): the caret range floor in package.json must equal the
 *      `expected` version in docs/protocol-pin.json. This guarantees the pin and
 *      the reconciled-against version can never drift apart unnoticed.
 *   2. NETWORK (best-effort): query npm for the published latest. If `expected`
 *      is behind the latest minor or major, fail. Network failures are treated
 *      as "skip" (warned, not fatal) so the gate is deterministic offline; the
 *      offline check still runs in every environment.
 *
 * Fix instructions are printed on failure.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const pkgPath = path.join(repoRoot, 'package.json');
const pinPath = path.join(repoRoot, 'docs/protocol-pin.json');

const PACKAGE_NAME = '@viewportai/protocol';

function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Extract the floor (lowest satisfying) version from a caret/tilde/exact range. */
function rangeFloor(range) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(range).trim());
  return m ? m[1] : null;
}

function isBehind(expected, latest) {
  if (latest.major !== expected.major) return latest.major > expected.major;
  if (latest.minor !== expected.minor) return latest.minor > expected.minor;
  // Patch drift is tolerated (caret range already picks up newer patches).
  return false;
}

function fail(lines) {
  console.error('Protocol pin drift check FAILED:');
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  console.error('To fix:');
  console.error(`  1. Bump "${PACKAGE_NAME}" in packages/daemon/package.json to the new caret range`);
  console.error('     (e.g. "^1.9.0" for a 1.9.x latest) and run `npm install`.');
  console.error('  2. Set "expected" in packages/daemon/docs/protocol-pin.json to the new version.');
  console.error('  3. Reconcile the policy schema copy (src/cli/policy-schema-validator.ts) and the');
  console.error('     conformance corpus version in tests/cli/policy-schema-validator.conformance.test.ts');
  console.error('     against the newly published protocol, then run `npm run daemon:test`.');
  process.exit(1);
}

async function main() {
  const [pkgRaw, pinRaw] = await Promise.all([
    fs.readFile(pkgPath, 'utf-8'),
    fs.readFile(pinPath, 'utf-8'),
  ]);
  const pkg = JSON.parse(pkgRaw);
  const pin = JSON.parse(pinRaw);

  const range =
    pkg.dependencies?.[PACKAGE_NAME] ??
    pkg.devDependencies?.[PACKAGE_NAME] ??
    pkg.peerDependencies?.[PACKAGE_NAME];

  if (!range) {
    fail([`${PACKAGE_NAME} is not present in package.json dependencies.`]);
  }

  const expected = pin.expected;
  const expectedSemver = parseSemver(expected);
  if (!expectedSemver) {
    fail([`docs/protocol-pin.json "expected" is not a valid semver: ${String(expected)}`]);
  }

  // Check 1 (offline): range floor must equal the expected version.
  const floor = rangeFloor(range);
  if (floor !== expected) {
    fail([
      `Pin range "${range}" (floor ${floor ?? '<none>'}) does not match the committed`,
      `expected version "${expected}" in docs/protocol-pin.json.`,
      'The package.json pin and the reconciled-against version have desynced.',
    ]);
  }

  // Check 2 (network, best-effort): is `expected` behind the published latest?
  let latest;
  try {
    latest = execFileSync('npm', ['view', PACKAGE_NAME, 'version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
    }).trim();
  } catch {
    console.warn(
      `Protocol pin check: could not reach npm to verify latest ${PACKAGE_NAME} (offline). ` +
        'Offline floor-vs-expected check passed.',
    );
    console.log(`Protocol pin check passed (pin ${range}, expected ${expected}, latest unverified).`);
    return;
  }

  const latestSemver = parseSemver(latest);
  if (!latestSemver) {
    console.warn(`Protocol pin check: npm returned an unparseable latest version "${latest}"; skipping drift comparison.`);
    console.log(`Protocol pin check passed (pin ${range}, expected ${expected}).`);
    return;
  }

  if (isBehind(expectedSemver, latestSemver)) {
    fail([
      `Pinned/expected protocol version ${expected} is BEHIND the published latest ${latest}.`,
      'A newer protocol minor/major has shipped and the daemon has not reconciled against it.',
    ]);
  }

  console.log(`Protocol pin check passed (pin ${range}, expected ${expected}, latest ${latest}).`);
}

await main();
