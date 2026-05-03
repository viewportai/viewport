import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowSessionLinkStore } from '../../src/workflows/session-links.js';
import type { WorkflowSessionLink } from '../../src/workflows/session-links.js';

let tempDir: string | undefined;

describe('workflow session links', () => {
  afterEach(async () => {
    if (!tempDir) return;
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('preserves concurrent upserts to the same store file', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-links-'));
    const filePath = path.join(tempDir, 'workflow-session-links.json');
    const store = new WorkflowSessionLinkStore(filePath);

    const links = Array.from({ length: 12 }, (_, index) =>
      makeLink({
        sessionId: `session-${index}`,
        workflowNodeId: `node-${index}`,
      }),
    );

    await Promise.all(links.map((link) => store.upsert(link)));

    const persisted = await store.list();
    expect(persisted).toHaveLength(links.length);
    expect(persisted.map((link) => link.sessionId).sort()).toEqual(
      links.map((link) => link.sessionId).sort(),
    );
  });
});

function makeLink(overrides: Partial<WorkflowSessionLink> = {}): WorkflowSessionLink {
  const now = Date.now();
  return {
    sessionId: crypto.randomUUID(),
    nativeSessionId: crypto.randomUUID(),
    workflowRunId: crypto.randomUUID(),
    workflowNodeId: 'node',
    parentDirectoryId: 'directory',
    parentDirectoryPath: '/tmp/project',
    worktreePath: '/tmp/project',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
