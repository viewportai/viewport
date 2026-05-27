import path from 'node:path';
import type { SessionContextProviderManifest } from '../config-resolution/index.js';
import type { WorkflowActionNode, WorkflowInputValue, WorkflowRunRecord } from './types.js';

export interface WorkflowAuthorityDenial {
  schema: 'viewport.workflow_authority_denial/v1';
  reason:
    | 'provider_action_not_allowed'
    | 'repository_not_allowed'
    | 'checkout_path_outside_run_worktree'
    | 'git_publish_path_outside_worktree'
    | 'git_publish_remote_mismatch'
    | 'git_publish_run_scoped_grant_unavailable'
    | 'context_update_target_wrong_repository'
    | 'context_source_not_allowed'
    | 'shell_policy_required'
    | 'shell_disabled_by_policy'
    | 'shell_cwd_outside_worktree'
    | 'shell_repository_not_allowed'
    | 'shell_provider_side_effect_not_allowed';
  runId: string;
  nodeId: string;
  detail: string;
  contractDigest: string | null;
  provider?: string;
  action?: string;
  repository?: string;
  contextSource?: string;
  command?: string;
  allowed?: string[];
}

interface AllowedSideEffect {
  provider: string;
  actions: string[];
}

export function workflowAuthorityContract(run: WorkflowRunRecord): Record<string, unknown> | null {
  return run.workflowAuthorityContract && typeof run.workflowAuthorityContract === 'object'
    ? run.workflowAuthorityContract
    : null;
}

export function workflowAuthorityContractDigest(run: WorkflowRunRecord): string | null {
  const contract = workflowAuthorityContract(run);
  return stringValue(contract?.['digest']) ?? stringValue(contract?.['contract_digest']) ?? null;
}

export function allowedRepositories(run: WorkflowRunRecord): string[] {
  const contract = workflowAuthorityContract(run);
  return stringArray(readPath(contract, ['repos', 'allowed']))
    .map(normalizeRepository)
    .filter(Boolean);
}

export function workflowActionAuthorityDenial(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
): WorkflowAuthorityDenial | null {
  const contract = workflowAuthorityContract(run);
  if (!contract) return null;

  const sideEffects = allowedSideEffects(contract);
  if (sideEffects.length > 0) {
    const provider = normalizeToken(node.adapter);
    const action = normalizeAction(node.action);
    const allowed = sideEffects.some((entry) => {
      if (entry.provider !== provider) return false;
      return entry.actions.length === 0 || entry.actions.includes(action);
    });
    if (!allowed) {
      return {
        schema: 'viewport.workflow_authority_denial/v1',
        reason: 'provider_action_not_allowed',
        runId: run.id,
        nodeId,
        provider: node.adapter,
        action: node.action,
        detail: `Workflow authority contract does not allow ${node.adapter}.${node.action}.`,
        contractDigest: workflowAuthorityContractDigest(run),
        allowed: sideEffects.flatMap((entry) =>
          entry.actions.length > 0
            ? entry.actions.map((actionName) => `${entry.provider}.${actionName}`)
            : [entry.provider],
        ),
      };
    }
  }

  const repository = actionRepository(node, actionInput);
  const repositories = allowedRepositories(run);
  if (repository && repositories.length > 0 && !repositories.includes(repository)) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'repository_not_allowed',
      runId: run.id,
      nodeId,
      provider: node.adapter,
      action: node.action,
      repository,
      detail: `Workflow authority contract does not allow repository ${repository}.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed: repositories,
    };
  }

  return null;
}

export function contextAuthorityDenial(
  run: WorkflowRunRecord,
  nodeId: string,
  provider: SessionContextProviderManifest,
  mode: 'read' | 'update_target' = 'read',
): WorkflowAuthorityDenial | null {
  const contract = workflowAuthorityContract(run);
  if (!contract) return null;

  const allowed = allowedContextRefs(contract, mode);
  if (allowed.length === 0) return null;

  const providerRefs = contextProviderRefs(provider);
  if (providerRefs.some((ref) => allowed.includes(ref))) return null;

  return {
    schema: 'viewport.workflow_authority_denial/v1',
    reason: 'context_source_not_allowed',
    runId: run.id,
    nodeId,
    contextSource: provider.id,
    detail: `Workflow authority contract does not allow context source ${provider.id} for ${mode}.`,
    contractDigest: workflowAuthorityContractDigest(run),
    allowed,
  };
}

export function shellAuthorityDenial(
  run: WorkflowRunRecord,
  nodeId: string,
  renderedCommand: string,
  cwd: string,
): WorkflowAuthorityDenial | null {
  const contract = workflowAuthorityContract(run);
  if (!contract) return null;

  const shellPolicy = shellExecutionPolicy(contract);
  if (shellPolicy !== 'constrained') {
    const reason =
      shellPolicy === 'disabled' ? 'shell_disabled_by_policy' : 'shell_policy_required';

    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason,
      runId: run.id,
      nodeId,
      command: redactedCommand(renderedCommand),
      detail:
        reason === 'shell_disabled_by_policy'
          ? 'Shell execution is disabled by the workflow authority contract.'
          : 'Shell execution under a workflow authority contract requires an explicit constrained shell policy.',
      contractDigest: workflowAuthorityContractDigest(run),
    };
  }

  if (!isPathWithin(cwd, run.directoryPath)) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'shell_cwd_outside_worktree',
      runId: run.id,
      nodeId,
      command: redactedCommand(renderedCommand),
      detail:
        'Shell node cwd is outside the run worktree. Use an in-worktree cwd or an explicit first-class checkout/worktree step.',
      contractDigest: workflowAuthorityContractDigest(run),
    };
  }

  const sideEffects = allowedSideEffects(contract);
  const sideEffectPolicyPresent = Array.isArray(readPath(contract, ['side_effects', 'allowed']));
  const forbiddenSideEffects = shellProviderSideEffects(renderedCommand).filter((effect) => {
    if (!sideEffectPolicyPresent) return false;
    return !sideEffects.some((allowed) => {
      if (allowed.provider !== effect.provider) return false;
      return allowed.actions.length === 0 || allowed.actions.includes(effect.action);
    });
  });
  const forbidden = forbiddenSideEffects[0];
  if (forbidden) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'shell_provider_side_effect_not_allowed',
      runId: run.id,
      nodeId,
      provider: forbidden.provider,
      action: forbidden.action,
      command: redactedCommand(renderedCommand),
      detail: `Shell command attempts ${forbidden.provider}.${forbidden.action}, which is outside workflow side-effect authority.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed: sideEffects.flatMap((entry) =>
        entry.actions.length > 0
          ? entry.actions.map((actionName) => `${entry.provider}.${actionName}`)
          : [entry.provider],
      ),
    };
  }

  const repositories = allowedRepositories(run);
  if (repositories.length === 0) return null;

  const requested = shellRepositoryRefs(renderedCommand);
  const denied = requested.find((repo) => !repositories.includes(repo));
  if (denied) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'shell_repository_not_allowed',
      runId: run.id,
      nodeId,
      repository: denied,
      command: redactedCommand(renderedCommand),
      detail: `Shell command references repository ${denied}, which is outside workflow repo authority.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed: repositories,
    };
  }

  return null;
}

function shellExecutionPolicy(contract: Record<string, unknown>): string | null {
  const nested = readPath(contract, ['shell', 'policy']);
  if (typeof nested === 'string' && nested.trim() !== '') return normalizeToken(nested);

  const flat = readPath(contract, ['shell_policy']);
  if (typeof flat === 'string' && flat.trim() !== '') return normalizeToken(flat);

  return null;
}

function allowedSideEffects(contract: Record<string, unknown>): AllowedSideEffect[] {
  const entries = arrayValue(readPath(contract, ['side_effects', 'allowed']));
  return entries
    .map((entry) => {
      if (typeof entry === 'string') {
        const [provider, action] = entry.split('.', 2);
        return provider
          ? { provider: normalizeToken(provider), actions: action ? [normalizeAction(action)] : [] }
          : null;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const provider = normalizeToken(
        stringValue(record['provider']) ?? stringValue(record['adapter']) ?? '',
      );
      if (!provider) return null;
      const action = stringValue(record['action']);
      const actions = stringArray(record['actions']);
      return {
        provider,
        actions: [...(action ? [action] : []), ...actions].map(normalizeAction).filter(Boolean),
      };
    })
    .filter((entry): entry is AllowedSideEffect => entry !== null);
}

function allowedContextRefs(
  contract: Record<string, unknown>,
  mode: 'read' | 'update_target',
): string[] {
  const candidates =
    mode === 'read'
      ? arrayValue(readPath(contract, ['context_sources', 'read']))
      : arrayValue(readPath(contract, ['context_sources', 'update_targets']));

  return candidates.flatMap(contextRefCandidates).map(normalizeContextRef).filter(Boolean);
}

function contextRefCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return [
    record['id'],
    record['ref'],
    record['source_ref'],
    record['sourceRef'],
    record['external_ref'],
    record['externalRef'],
    record['context_source_id'],
    record['contextSourceId'],
    record['provider_id'],
    record['providerId'],
    record['url'],
    record['source_url'],
    record['sourceUrl'],
  ].flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
}

function contextProviderRefs(provider: SessionContextProviderManifest): string[] {
  return [
    provider.id,
    provider.vault,
    provider.ref,
    provider.repo,
    provider.remote,
    provider.sourceConfigPath,
    `context://${provider.id}`,
    provider.vault ? `context://${provider.vault}` : undefined,
    provider.vault ? `context://vault/${provider.vault}` : undefined,
    `context_vault:${provider.id}`,
    provider.vault ? `context_vault:${provider.vault}` : undefined,
    `provider://${provider.id}`,
    provider.vault ? `provider://${provider.vault}` : undefined,
    provider.repo ? `git://${normalizeRepository(provider.repo)}` : undefined,
  ]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .flatMap((entry) => [entry, entry.replace(/\.git$/, '')])
    .map(normalizeContextRef)
    .filter(Boolean);
}

function actionRepository(
  node: WorkflowActionNode,
  input: Record<string, WorkflowInputValue>,
): string | null {
  if (node.adapter !== 'github') return null;
  const repository =
    stringValue(input['repository']) ??
    stringValue(input['repo_full_name']) ??
    stringValue(input['repoFullName']) ??
    stringValue(input['repo_name']);
  if (repository) return normalizeRepository(repository);

  const owner = stringValue(input['owner']);
  const repo = stringValue(input['repo']);
  return owner && repo ? normalizeRepository(`${owner}/${repo}`) : null;
}

function shellProviderSideEffects(command: string): Array<{ provider: string; action: string }> {
  const normalized = command.toLowerCase();
  const effects: Array<{ provider: string; action: string }> = [];
  if (/\bgh\s+pr\s+create\b/.test(normalized)) {
    effects.push({ provider: 'github', action: 'create-pr' });
  }
  if (/\bgit\s+push\b/.test(normalized)) {
    effects.push({ provider: 'github', action: 'push-branch' });
  }
  if (/\bcurl\b/.test(normalized) && /api\.github\.com\/repos\//.test(normalized)) {
    effects.push({ provider: 'github', action: 'api-request' });
  }
  if (/\bcurl\b/.test(normalized) && /slack\.com\/api\/chat\.postmessage/.test(normalized)) {
    effects.push({ provider: 'slack', action: 'post-message' });
  }
  return effects;
}

function shellRepositoryRefs(command: string): string[] {
  const repos = new Set<string>();
  const patterns = [
    /git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/gi,
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/gi,
    /api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
    /(?:--repo|-R)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
    /\bgh\s+repo\s+clone\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const repo = normalizeRepository(match[1]);
      if (repo) repos.add(repo);
    }
  }

  return [...repos];
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function redactedCommand(command: string): string {
  return command
    .replace(/(gh[ps]_[A-Za-z0-9_]+)/g, '[redacted-token]')
    .replace(/(xox[baprs]-[A-Za-z0-9-]+)/g, '[redacted-token]')
    .slice(0, 500);
}

function normalizeRepository(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function normalizeContextRef(value: string): string {
  return value
    .trim()
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function normalizeAction(value: string): string {
  return normalizeToken(value).replace(/^chat\./, 'chat-');
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === 'string');
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
