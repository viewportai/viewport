/**
 * Conformance proof for the `vpd check` copy of PolicyDocumentSchema.
 *
 * The canonical fixture corpus lives in protocol/fixtures. This test keeps the
 * daemon CLI validator aligned with the protocol, platform API, and web suites
 * until the daemon imports @viewportai/protocol directly.
 */
import { readFileSync } from 'node:fs';
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

const corpusPath = path.resolve(
  process.cwd(),
  '../../../protocol/fixtures/policy-conformance-corpus.json',
);
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as Corpus;

describe('daemon PolicyDocumentSchema conformance', () => {
  it('uses the shared corpus version', () => {
    expect(corpus.version).toBe('2026-05-31/23');
    expect(corpus.fixtures).toHaveLength(23);
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
