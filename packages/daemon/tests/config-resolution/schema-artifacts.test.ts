import Ajv from 'ajv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = path.resolve(__dirname, '..', '..');

describe('published contract schema artifacts', () => {
  it('validates the canonical .viewport/config.yaml shape', async () => {
    const schema = await readSchema('viewport-config-v1.schema.json');
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);

    const config = YAML.parse(`
version: 1
name: viewport
context:
  providers:
    - id: repo_docs
      provider: repo-docs
      paths: [CLAUDE.md, docs/**/*.md]
    - id: platform_arch
      provider: viewport-vault
      vault: ctx_platform_arch
      required: true
  resolution:
    order: [repo_docs, platform_arch]
    size_budget: 64kb
    strategy: provider_order
    propose_fallback_provider: platform_arch
workflows:
  review-pr:
    path: .viewport/workflows/review-pr.yaml
    digest: sha256:abc123
approvals:
  risky_paths:
    - id: auth-touch
      path: apps/api/Auth/**
      require: [reviewer:security]
      checks:
        - npm run test -- session-rotation
`);

    expect(validate(config)).toBe(true);
  });

  it('rejects inline provider credentials in published schema artifacts', async () => {
    const schema = await readSchema('viewport-config-v1.schema.json');
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);

    const config = YAML.parse(`
version: 1
context:
  providers:
    - id: notebook
      provider: notebooklm
      token: do-not-commit
`);

    expect(validate(config)).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain('not');
  });

  it('validates the canonical workflow YAML shape', async () => {
    const schema = await readSchema('workflow-v1.schema.json');
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);

    const workflow = YAML.parse(`
schema: viewport.workflow/v1
name: review-pr
title: Review pull request
inputs:
  brief:
    type: string
    required: true
nodes:
  inspect:
    type: shell
    command: git diff --stat
    outputs:
      summary:
        type: string
  plan:
    type: plan
    needs: [inspect]
    title: Review plan
    body: "Plan from {{ nodes.inspect.outputs.summary }}"
    waitForApproval: true
`);

    expect(validate(workflow)).toBe(true);
  });
});

async function readSchema(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(root, 'schemas', file), 'utf8')) as Record<
    string,
    unknown
  >;
}
