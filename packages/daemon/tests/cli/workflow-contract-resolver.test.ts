import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkflowRunTarget } from '../../src/cli/workflow-contract-resolver.js';
import { resolveWorkflowSource } from '../../src/workflows/workflow-source.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-workflow-contract-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('workflow contract resolver', () => {
  it('resolves a declared workflow id from repo contract', async () => {
    const repo = path.join(root, 'repo');
    const workflowPath = path.join(repo, '.viewport', 'workflows', 'review.yaml');
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      ['version: 1', 'workflows:', '  review-pr: .viewport/workflows/review.yaml', ''].join('\n'),
    );
    await fs.writeFile(workflowPath, workflowYaml('review-pr'));

    const resolved = resolveWorkflowRunTarget({
      workflowTarget: 'review-pr',
      directoryPath: path.join(repo, 'apps', 'web'),
      cwd: root,
    });

    expect(resolved.workflowPath).toBe(workflowPath);
    expect(resolved.workflowContract).toMatchObject({
      id: 'review-pr',
      sourceConfigPath: path.join(repo, '.viewport', 'config.yaml'),
      declaredPath: '.viewport/workflows/review.yaml',
      status: 'verified',
    });
    expect(resolved.resourceManifest.contract.workflows).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'review-pr' })]),
    );
  });

  it('marks direct undeclared workflow files as explicit escape hatches', async () => {
    const repo = path.join(root, 'repo');
    const workflowPath = path.join(repo, 'scratch.yaml');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(workflowPath, workflowYaml('scratch'));

    const resolved = resolveWorkflowRunTarget({
      workflowTarget: 'scratch.yaml',
      directoryPath: repo,
      cwd: repo,
    });

    expect(resolved.workflowPath).toBe(workflowPath);
    expect(resolved.workflowContract).toMatchObject({
      status: 'undeclared',
      reason: 'workflow target is not declared in .viewport/config.yaml',
    });
  });

  it('rejects pinned workflow digest mismatches before execution', async () => {
    const repo = path.join(root, 'repo');
    const workflowPath = path.join(repo, 'workflow.yaml');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(workflowPath, workflowYaml('digest-proof'));

    await expect(
      resolveWorkflowSource(
        {
          workflowPath,
          workflowContract: {
            id: 'digest-proof',
            status: 'verified',
            declaredDigest: 'sha256:bad',
          },
          directoryId: 'dir',
          initiation: 'cli',
        },
        repo,
      ),
    ).rejects.toThrow(/Workflow digest mismatch/);
  });
});

function workflowYaml(name: string): string {
  return [
    'schema: viewport.workflow/v1',
    `name: ${name}`,
    'nodes:',
    '  inspect:',
    '    type: shell',
    '    command: "echo ok"',
    '',
  ].join('\n');
}
