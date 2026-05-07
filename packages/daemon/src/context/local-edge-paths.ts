import path from 'node:path';

export function projectMetadataPath(projectId: string, home: string): string {
  return path.join(home, 'context', 'canonical-projects', `${safeProjectId(projectId)}.json`);
}

export function legacyContextProjectPath(projectId: string, home: string): string {
  return path.join(home, 'context', 'projects', `${safeProjectId(projectId)}.json`);
}

export function archivedContextProjectPath(projectId: string, home: string): string {
  return path.join(
    home,
    'context',
    'projects',
    '.archived',
    `${safeProjectId(projectId)}.seam-v0.json`,
  );
}

export function repoIdForProject(projectId: string): string {
  return safeProjectId(projectId);
}

export function safeProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
