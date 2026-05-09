import path from 'node:path';

export function contextMetadataPath(contextResourceId: string, home: string): string {
  return path.join(
    home,
    'context',
    'canonical-resources',
    `${safeContextResourceId(contextResourceId)}.json`,
  );
}

export function repoIdForContextResource(contextResourceId: string): string {
  return safeContextResourceId(contextResourceId);
}

export function safeContextResourceId(contextResourceId: string): string {
  return contextResourceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
