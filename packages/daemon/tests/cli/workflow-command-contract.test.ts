import { describe, expect, it } from 'vitest';
import { buildWorkflowRunJsonOutput } from '../../src/cli/workflow-commands.js';

describe('workflow CLI JSON contract', () => {
  it('exposes a stable agent-facing workflow run shape', () => {
    const output = buildWorkflowRunJsonOutput({
      id: 'run_demo',
      workflowName: 'review-pr',
      workflowTitle: 'Review pull request',
      digest: 'sha256:workflowdigest',
      status: 'blocked',
    });

    expect(output).toMatchObject({
      schema_version: 'viewport.cli.workflow_run/v1',
      command: 'workflow run',
      ok: false,
      run_id: 'run_demo',
      workflow: {
        id: 'review-pr',
        name: 'Review pull request',
        digest: 'sha256:workflowdigest',
      },
      status: 'blocked',
      manifest_digest: 'sha256:workflowdigest',
      steps: [],
      run: {
        id: 'run_demo',
      },
    });
  });
});
