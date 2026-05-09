import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import type { ContextCandidateDecisionApplication } from './local-edge-types.js';
import { safeContextResourceId } from './local-edge-paths.js';

export async function recordCandidateDecisionApplication(options: {
  application: ContextCandidateDecisionApplication;
  home: string;
  contextResourceId: string;
}): Promise<void> {
  const applications = await readCandidateDecisionApplications({
    home: options.home,
    contextResourceId: options.contextResourceId,
  });
  const key = applicationKey(options.application);
  const next = [
    ...applications.filter((application) => applicationKey(application) !== key),
    options.application,
  ].sort((left, right) => left.applied_at.localeCompare(right.applied_at));

  const file = applicationsPath(options.home, options.contextResourceId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export async function readCandidateDecisionApplications(options: {
  home?: string;
  contextResourceId?: string;
  since?: string;
}): Promise<ContextCandidateDecisionApplication[]> {
  const home = options.home ?? configDir();
  const files = options.contextResourceId
    ? [applicationsPath(home, options.contextResourceId)]
    : await applicationFiles(home);

  const applications: ContextCandidateDecisionApplication[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (isCandidateDecisionApplication(item)) {
          applications.push(item);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  return applications
    .filter((application) => !options.since || application.applied_at > options.since)
    .sort((left, right) => left.applied_at.localeCompare(right.applied_at));
}

export function applicationsPath(home: string, contextResourceId: string): string {
  return path.join(
    home,
    'context',
    'candidate-decision-applications',
    `${safeContextResourceId(contextResourceId)}.json`,
  );
}

async function applicationFiles(home: string): Promise<string[]> {
  const dir = path.join(home, 'context', 'candidate-decision-applications');
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function applicationKey(application: ContextCandidateDecisionApplication): string {
  return `${application.decision_id}:${application.actor_name}`;
}

function isCandidateDecisionApplication(
  value: unknown,
): value is ContextCandidateDecisionApplication {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ContextCandidateDecisionApplication>;
  return (
    record.schema_version === 'viewport.context_candidate_application/v1' &&
    typeof record.decision_id === 'string' &&
    typeof record.repo_id === 'string' &&
    typeof record.candidate_event_id === 'string' &&
    (record.decision === 'approved' || record.decision === 'rejected') &&
    (record.status === 'applied' || record.status === 'skipped') &&
    typeof record.actor_name === 'string' &&
    typeof record.applied_at === 'string' &&
    typeof record.platform_signature_digest === 'string'
  );
}
