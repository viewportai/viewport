import { getFlag } from './args.js';
import { ConfigManager, type ViewportConfig } from '../core/config.js';
import { resolveLocalOrgBindingSync } from './org-binding.js';

export interface ContextSyncTarget {
  contextResourceId: string;
  workspaceId: string;
  serverUrl: string;
  credential: string;
  teamId?: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
  decisionSigningKeys?: Record<string, string>;
}

export interface WorkspaceSyncTarget {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  runtimeTargetId?: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
}

export async function resolveContextSyncTarget(commandName: string): Promise<ContextSyncTarget> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  const relay = daemon.relay ?? {};

  const contextResourceId = getFlag('context') ?? getFlag('project');
  const explicitWorkspaceId = getFlag('workspace');
  const explicitServerUrl = getFlag('server-url');
  const explicitCredential = getFlag('credential');
  const explicitTeamId = getFlag('team');
  const decisionSigningKeys =
    parseDecisionSigningKeys(
      getFlag('context-decision-key') ??
        getFlag('decision-key') ??
        envValue('VIEWPORT_CONTEXT_DECISION_KEY'),
    ) ?? daemon.server?.contextCandidateDecisionKeys;

  if (!contextResourceId) {
    throw new Error(
      `vpd context ${commandName} requires --context <resource-id>; saved remote workspace ids are not context ids`,
    );
  }

  if (explicitWorkspaceId && explicitServerUrl && explicitCredential) {
    return {
      contextResourceId,
      workspaceId: explicitWorkspaceId,
      serverUrl: explicitServerUrl,
      credential: explicitCredential,
      teamId: explicitTeamId,
      tlsVerify: daemon.server?.tlsVerify ?? relay.tlsVerify,
      caCertPath: daemon.server?.caCertPath ?? relay.caCertPath,
      tlsPins: daemon.server?.tlsPins ?? relay.tlsPins,
      decisionSigningKeys,
    };
  }

  const target = resolveConfiguredContextSyncTarget(daemon, {
    contextResourceId,
    requestedWorkspaceId:
      explicitWorkspaceId ?? resolveLocalOrgBindingSync(process.cwd())?.organizationId,
    explicitServerUrl,
    explicitCredential,
    explicitTeamId,
    decisionSigningKeys,
  });

  if (!target) {
    throw new Error(
      `vpd context ${commandName} requires an unambiguous remote workspace. Pass --workspace <id>, run from a bound repo, or keep exactly one saved remote workspace binding.`,
    );
  }

  return target;
}

export async function resolveWorkspaceSyncTarget(
  commandName: string,
): Promise<WorkspaceSyncTarget> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  const relay = daemon.relay ?? {};

  const explicitWorkspaceId = getFlag('workspace');
  const explicitServerUrl = getFlag('server-url');
  const explicitCredential = getFlag('credential');

  if (explicitWorkspaceId && explicitServerUrl && explicitCredential) {
    return {
      workspaceId: explicitWorkspaceId,
      serverUrl: explicitServerUrl,
      credential: explicitCredential,
      tlsVerify: daemon.server?.tlsVerify ?? relay.tlsVerify,
      caCertPath: daemon.server?.caCertPath ?? relay.caCertPath,
      tlsPins: daemon.server?.tlsPins ?? relay.tlsPins,
    };
  }

  const target = resolveConfiguredWorkspaceSyncTarget(daemon, {
    requestedWorkspaceId:
      explicitWorkspaceId ?? resolveLocalOrgBindingSync(process.cwd())?.organizationId,
    explicitServerUrl,
    explicitCredential,
  });

  if (!target) {
    throw new Error(
      `vpd context ${commandName} requires an unambiguous remote workspace. Pass --workspace <id>, run from a bound repo, or keep exactly one saved remote workspace binding.`,
    );
  }

  return target;
}

export function resolveConfiguredContextSyncTarget(
  daemon: NonNullable<ViewportConfig['daemon']>,
  options: {
    contextResourceId: string;
    requestedWorkspaceId?: string;
    explicitServerUrl?: string;
    explicitCredential?: string;
    explicitTeamId?: string;
    decisionSigningKeys?: Record<string, string>;
  },
): ContextSyncTarget | null {
  const target = resolveConfiguredWorkspaceSyncTarget(daemon, options);
  if (!target) return null;

  return {
    ...target,
    contextResourceId: options.contextResourceId,
    teamId: options.explicitTeamId,
    decisionSigningKeys: options.decisionSigningKeys,
  };
}

export function resolveConfiguredWorkspaceSyncTarget(
  daemon: NonNullable<ViewportConfig['daemon']>,
  options: {
    requestedWorkspaceId?: string;
    explicitServerUrl?: string;
    explicitCredential?: string;
  } = {},
): WorkspaceSyncTarget | null {
  const relay = daemon.relay ?? {};
  if (options.requestedWorkspaceId && options.explicitServerUrl && options.explicitCredential) {
    return {
      workspaceId: options.requestedWorkspaceId,
      serverUrl: options.explicitServerUrl,
      credential: options.explicitCredential,
      tlsVerify: daemon.server?.tlsVerify ?? relay.tlsVerify,
      caCertPath: daemon.server?.caCertPath ?? relay.caCertPath,
      tlsPins: daemon.server?.tlsPins ?? relay.tlsPins,
    };
  }

  const targets = configuredWorkspaceTargets(daemon)
    .map((target) => ({
      ...target,
      serverUrl: options.explicitServerUrl ?? target.serverUrl,
      credential: options.explicitCredential ?? target.credential,
    }))
    .filter((target) => target.workspaceId && target.serverUrl && target.credential);

  if (options.requestedWorkspaceId) {
    const match = targets.find((target) => target.workspaceId === options.requestedWorkspaceId);
    return match ?? null;
  }

  const unique = new Map<string, WorkspaceSyncTarget>();
  for (const target of targets) {
    unique.set(target.workspaceId, target);
  }

  if (unique.size !== 1) return null;
  const [target] = unique.values();
  return target ?? null;
}

function configuredWorkspaceTargets(
  daemon: NonNullable<ViewportConfig['daemon']>,
): WorkspaceSyncTarget[] {
  const relay = daemon.relay ?? {};
  const bindings = relay.bindings ?? [];
  const candidates = [
    ...bindings.filter((binding) => binding.enabled !== false),
    ...(relay.workspaceId || relay.serverUrl || relay.issueToken
      ? [
          {
            enabled: relay.enabled,
            workspaceId: relay.workspaceId,
            serverUrl: relay.serverUrl,
            issueToken: relay.issueToken,
            tlsVerify: relay.tlsVerify,
            caCertPath: relay.caCertPath,
            tlsPins: relay.tlsPins,
          },
        ]
      : []),
  ];

  return candidates.flatMap((binding) => {
    const workspaceId = binding.workspaceId;
    const serverUrl = binding.serverUrl ?? relay.serverUrl ?? daemon.server?.url;
    const credential = binding.issueToken;
    if (!workspaceId || !serverUrl || !credential) return [];
    return [
      {
        workspaceId,
        serverUrl,
        credential,
        runtimeTargetId: binding.runtimeTargetId,
        tlsVerify: daemon.server?.tlsVerify ?? binding.tlsVerify ?? relay.tlsVerify,
        caCertPath: daemon.server?.caCertPath ?? binding.caCertPath ?? relay.caCertPath,
        tlsPins: daemon.server?.tlsPins ?? binding.tlsPins ?? relay.tlsPins,
      },
    ];
  });
}

function parseDecisionSigningKeys(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Context decision signing keys JSON must be an object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([kid, key]) =>
        typeof key === 'string' && key.length > 0 ? [[kid, key]] : [],
      ),
    );
  }

  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error('Context decision signing key must use kid:base64-public-key format');
  }

  return {
    [trimmed.slice(0, separator)]: trimmed.slice(separator + 1),
  };
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
