/**
 * Conformance proof for the `vpd check` copy of PolicyDocumentSchema.
 *
 * The canonical fixture corpus lives in protocol/fixtures. This test keeps the
 * daemon CLI validator aligned with the protocol, platform API, and web suites
 * until the daemon imports @viewportai/protocol directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { PolicyDocumentSchema } from '../../src/cli/policy-schema-validator.js';

type Fixture = {
  name: string;
  expect: 'accept' | 'reject';
  yaml: string;
  reason?: string;
};

type Corpus = {
  version: string;
  fixtures: Fixture[];
};

function findProtocolCorpusPath(startDir: string): string {
  let current = startDir;

  while (true) {
    const candidate = path.join(
      current,
      'node_modules',
      '@viewportai',
      'protocol',
      'fixtures',
      'policy-conformance-corpus.json',
    );
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        'Could not find @viewportai/protocol policy conformance corpus in node_modules',
      );
    }
    current = parent;
  }
}

const corpusPath = findProtocolCorpusPath(process.cwd());
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as Corpus;

describe('daemon PolicyDocumentSchema conformance', () => {
  it('uses the shared corpus version', () => {
    expect(corpus.version).toBe('2026-06-01/26');
    expect(corpus.fixtures).toHaveLength(26);
  });

  it('accepts every shared accept fixture', () => {
    for (const fixture of corpus.fixtures.filter((item) => item.expect === 'accept')) {
      const result = PolicyDocumentSchema.safeParse(parseYaml(fixture.yaml));
      expect(result.success, `Fixture '${fixture.name}' was unexpectedly rejected`).toBe(true);
    }
  });

  it('rejects every shared reject fixture', () => {
    for (const fixture of corpus.fixtures.filter((item) => item.expect === 'reject')) {
      const result = PolicyDocumentSchema.safeParse(parseYaml(fixture.yaml));
      expect(
        result.success,
        `Fixture '${fixture.name}' was NOT rejected — expected: ${fixture.reason}`,
      ).toBe(false);
    }
  });
});
