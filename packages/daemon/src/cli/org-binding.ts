import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export const VIEWPORT_DIR = '.viewport';
export const LOCAL_BINDING_FILE = 'local.yaml';
export const WORKSPACE_HINT_FILE = 'workspace.yaml';
export const WORKSPACE_HINT_DECLINES_FILE = 'hint-declines.json';

export interface LocalOrgBinding {
  filePath: string;
  directory: string;
  organizationId: string;
  streamEnabled: boolean;
}

export interface WorkspaceOrgHint {
  filePath: string;
  directory: string;
  organizationId: string;
}

interface BindingDocument {
  organization_id?: unknown;
  org_id?: unknown;
  workspace_id?: unknown;
  organization?: {
    id?: unknown;
  };
  workspace?: {
    id?: unknown;
  };
  remote?: {
    stream?: unknown;
  };
}

export function localBindingPath(directory: string): string {
  return path.join(path.resolve(directory), VIEWPORT_DIR, LOCAL_BINDING_FILE);
}

export function workspaceHintPath(directory: string): string {
  return path.join(path.resolve(directory), VIEWPORT_DIR, WORKSPACE_HINT_FILE);
}

export async function writeLocalOrgBinding(options: {
  directory: string;
  organizationId: string;
  streamEnabled?: boolean;
}): Promise<LocalOrgBinding> {
  const directory = path.resolve(options.directory);
  const viewportDir = path.join(directory, VIEWPORT_DIR);
  await fs.mkdir(viewportDir, { recursive: true });
  const filePath = localBindingPath(directory);
  const document = {
    version: 1,
    organization_id: options.organizationId,
    remote: {
      stream: (options.streamEnabled ?? true) ? 'enabled' : 'disabled',
    },
  };
  await fs.writeFile(filePath, YAML.stringify(document), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  await ensureViewportLocalGitignore(directory);
  return {
    filePath,
    directory,
    organizationId: options.organizationId,
    streamEnabled: options.streamEnabled ?? true,
  };
}

export async function ensureViewportLocalGitignore(directory: string): Promise<void> {
  const viewportDir = path.join(path.resolve(directory), VIEWPORT_DIR);
  await fs.mkdir(viewportDir, { recursive: true });
  const gitignorePath = path.join(viewportDir, '.gitignore');
  const protectedFiles = [`/${LOCAL_BINDING_FILE}`, `/${WORKSPACE_HINT_DECLINES_FILE}`];
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    existing = '';
  }
  const lines = existing
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const missing = protectedFiles.filter((line) => !lines.includes(line));
  if (missing.length === 0) return;
  const next = `${existing.trimEnd()}${existing.trim().length > 0 ? '\n' : ''}${missing.join('\n')}\n`;
  await fs.writeFile(gitignorePath, next, { encoding: 'utf8' });
}

export async function recordWorkspaceOrgHintDecline(options: {
  directory: string;
  organizationId: string;
}): Promise<void> {
  const directory = path.resolve(options.directory);
  const viewportDir = path.join(directory, VIEWPORT_DIR);
  await fs.mkdir(viewportDir, { recursive: true });
  const filePath = workspaceHintDeclinesPath(directory);
  const document = await readHintDeclinesDocument(filePath);
  const declined = new Set(document.declinedOrganizationIds);
  declined.add(options.organizationId);
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        version: 1,
        declinedOrganizationIds: [...declined].sort(),
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.chmod(filePath, 0o600);
  await ensureViewportLocalGitignore(directory);
}

export function workspaceOrgHintDeclinedSync(options: {
  directory: string;
  organizationId: string;
}): boolean {
  const filePath = workspaceHintDeclinesPath(options.directory);
  const document = readHintDeclinesDocumentSync(filePath);
  return document.declinedOrganizationIds.includes(options.organizationId);
}

export function resolveLocalOrgBindingSync(startDirectory: string): LocalOrgBinding | null {
  const match = findNearestFileSync(startDirectory, path.join(VIEWPORT_DIR, LOCAL_BINDING_FILE));
  if (!match) return null;
  const parsed = parseYamlFileSync(match.filePath);
  const organizationId = readOrganizationId(parsed);
  if (!organizationId) return null;
  return {
    filePath: match.filePath,
    directory: match.directory,
    organizationId,
    streamEnabled: readStreamEnabled(parsed),
  };
}

export function resolveWorkspaceOrgHintSync(startDirectory: string): WorkspaceOrgHint | null {
  const match = findNearestFileSync(startDirectory, path.join(VIEWPORT_DIR, WORKSPACE_HINT_FILE));
  if (!match) return null;
  const parsed = parseYamlFileSync(match.filePath);
  const organizationId = readOrganizationId(parsed);
  if (!organizationId) return null;
  return {
    filePath: match.filePath,
    directory: match.directory,
    organizationId,
  };
}

export function directoryStreamsToOrganization(options: {
  directory: string | null | undefined;
  organizationId: string;
}): boolean {
  if (!options.directory) return false;
  const binding = resolveLocalOrgBindingSync(options.directory);
  return binding?.streamEnabled === true && binding.organizationId === options.organizationId;
}

function findNearestFileSync(
  startDirectory: string,
  relativeFile: string,
): { directory: string; filePath: string } | null {
  let current = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(current, relativeFile);
    if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
      return { directory: current, filePath: candidate };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseYamlFileSync(filePath: string): BindingDocument {
  try {
    const parsed = YAML.parse(fsSync.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as BindingDocument;
  } catch {
    return {};
  }
}

function workspaceHintDeclinesPath(directory: string): string {
  return path.join(path.resolve(directory), VIEWPORT_DIR, WORKSPACE_HINT_DECLINES_FILE);
}

async function readHintDeclinesDocument(
  filePath: string,
): Promise<{ declinedOrganizationIds: string[] }> {
  try {
    return normalizeHintDeclinesDocument(
      JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown,
    );
  } catch {
    return { declinedOrganizationIds: [] };
  }
}

function readHintDeclinesDocumentSync(filePath: string): { declinedOrganizationIds: string[] } {
  try {
    return normalizeHintDeclinesDocument(
      JSON.parse(fsSync.readFileSync(filePath, 'utf8')) as unknown,
    );
  } catch {
    return { declinedOrganizationIds: [] };
  }
}

function normalizeHintDeclinesDocument(value: unknown): { declinedOrganizationIds: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { declinedOrganizationIds: [] };
  }
  const raw = (value as { declinedOrganizationIds?: unknown }).declinedOrganizationIds;
  if (!Array.isArray(raw)) return { declinedOrganizationIds: [] };
  return {
    declinedOrganizationIds: raw.filter((entry): entry is string => typeof entry === 'string'),
  };
}

function readOrganizationId(document: BindingDocument): string | null {
  for (const value of [
    document.organization_id,
    document.org_id,
    document.workspace_id,
    document.organization?.id,
    document.workspace?.id,
  ]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readStreamEnabled(document: BindingDocument): boolean {
  const raw = document.remote?.stream;
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === 'enabled' || normalized === 'true' || normalized === '1' || normalized === 'on'
  );
}
