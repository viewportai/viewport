import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowNode, WorkflowRunArtifactRecord, WorkflowRunRecord } from './types.js';
import { renderTemplate } from './runtime-helpers.js';

const MAX_DIGEST_BYTES = 10 * 1024 * 1024;

export interface ArtifactCollectionResult {
  artifacts: WorkflowRunArtifactRecord[];
  missing: Array<{ name: string; path: string; reason: string }>;
}

export async function collectNodeArtifacts(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
  cwd: string,
): Promise<ArtifactCollectionResult> {
  const artifacts: WorkflowRunArtifactRecord[] = [];
  const missing: ArtifactCollectionResult['missing'] = [];

  for (const [name, definition] of Object.entries(node.artifacts ?? {})) {
    const renderedPath = renderTemplate(definition.path, run);
    const artifactPath = path.isAbsolute(renderedPath)
      ? renderedPath
      : path.resolve(cwd, renderedPath);
    const safeRoot = path.resolve(run.directoryPath);
    if (!isWithinPath(artifactPath, safeRoot)) {
      missing.push({ name, path: artifactPath, reason: 'outside workflow directory' });
      continue;
    }

    try {
      const stat = await fs.stat(artifactPath);
      const kind = definition.type ?? (stat.isDirectory() ? 'directory' : 'file');
      const digest =
        stat.isFile() && stat.size <= MAX_DIGEST_BYTES ? await digestFile(artifactPath) : undefined;
      artifacts.push({
        id: crypto.randomUUID(),
        runId: run.id,
        nodeId,
        name,
        kind,
        path: artifactPath,
        ...(digest ? { digest } : {}),
        ...(definition.description ? { description: definition.description } : {}),
        sizeBytes: stat.size,
        createdAt: Date.now(),
        metadata: {
          declaredPath: definition.path,
          ...(digest ? { digest } : {}),
          ...(stat.isFile() && stat.size > MAX_DIGEST_BYTES
            ? { digestSkipped: 'file too large' }
            : {}),
        },
      });
    } catch (error) {
      const reason =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : 'unreadable';
      missing.push({ name, path: artifactPath, reason });
    }
  }

  return { artifacts, missing };
}

function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function digestFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}
