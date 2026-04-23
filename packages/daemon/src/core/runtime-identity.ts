import path from 'node:path';
import type { ViewportConfig } from './config.js';
import { resolveProjectConfigDir, resolveViewportHome } from './config.js';
import type { DeploymentProfile } from '../server/security.js';

export type DaemonRuntimeKind = 'managed' | 'local-dev' | 'self-hosted';
export type DaemonHomeScope = 'global' | 'project-override';
export type DaemonHomeSource = 'default' | 'explicit';

export interface DaemonRuntimeIdentity {
  machineId?: string;
  daemonVersion: string;
  runtimeKind: DaemonRuntimeKind;
  daemonHome: string;
  daemonHomeScope: DaemonHomeScope;
  daemonHomeSource: DaemonHomeSource;
  profile?: DeploymentProfile;
  serverUrl?: string;
  relayEndpoint?: string;
  relayServerUrl?: string;
  relayWorkspaceId?: string;
  hostedDefaults: boolean;
}

export interface InstallRuntimeCapabilities {
  daemonVersion: string;
  runtimeKind: DaemonRuntimeKind;
  daemonHomeScope: DaemonHomeScope;
  profile?: DeploymentProfile;
  serverUrl?: string;
  relayEndpoint?: string;
  relayServerUrl?: string;
}

export interface InstallCapabilities {
  runtime: InstallRuntimeCapabilities;
}

interface ResolveDaemonRuntimeIdentityInput {
  daemonConfig?: ViewportConfig['daemon'];
  env?: NodeJS.ProcessEnv;
  machineId?: string;
  daemonVersion: string;
}

const HOSTED_HOSTS = new Set([
  'getviewport.com',
  'app.getviewport.com',
  'relay.getviewport.com',
  'getviewport.dev',
  'app.getviewport.dev',
  'relay.getviewport.dev',
]);

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseHost(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.test')
  );
}

function isHostedHost(host: string | undefined): boolean {
  if (!host) return false;
  return HOSTED_HOSTS.has(host);
}

function resolveRuntimeKind(input: {
  explicitKind?: string;
  daemonHomeSource: DaemonHomeSource;
  serverUrl?: string;
  relayEndpoint?: string;
  relayServerUrl?: string;
}): DaemonRuntimeKind {
  const explicitKind = input.explicitKind?.trim().toLowerCase();
  if (
    explicitKind === 'managed' ||
    explicitKind === 'local-dev' ||
    explicitKind === 'self-hosted'
  ) {
    return explicitKind;
  }

  const hosts = [input.serverUrl, input.relayEndpoint, input.relayServerUrl].map(parseHost);
  if (input.daemonHomeSource === 'explicit' || hosts.some((host) => isLocalHost(host))) {
    return 'local-dev';
  }

  if (hosts.some((host) => host && !isHostedHost(host))) {
    return 'self-hosted';
  }

  return 'managed';
}

export function resolveDaemonRuntimeIdentity(
  input: ResolveDaemonRuntimeIdentityInput,
): DaemonRuntimeIdentity {
  const env = input.env ?? process.env;
  const daemonConfig = input.daemonConfig;
  const daemonHomeSource: DaemonHomeSource =
    envValue(env, 'VIEWPORT_HOME', 'VPD_HOME') !== undefined ? 'explicit' : 'default';
  const daemonHome = resolveViewportHome(env);
  const projectConfigDir = resolveProjectConfigDir(env);
  const serverUrl =
    daemonConfig?.server?.url ??
    daemonConfig?.relay?.serverUrl ??
    envValue(env, 'VIEWPORT_SERVER_URL', 'VPD_SERVER_URL');
  const relayEndpoint =
    daemonConfig?.relay?.endpoint ?? envValue(env, 'VIEWPORT_RELAY_ENDPOINT', 'VPD_RELAY_ENDPOINT');
  const relayServerUrl =
    daemonConfig?.relay?.serverUrl ?? envValue(env, 'VIEWPORT_RELAY_SERVER', 'VPD_RELAY_SERVER');
  const runtimeKind = resolveRuntimeKind({
    explicitKind: envValue(env, 'VIEWPORT_RUNTIME_KIND', 'VPD_RUNTIME_KIND'),
    daemonHomeSource,
    serverUrl,
    relayEndpoint,
    relayServerUrl,
  });

  const hosts = [serverUrl, relayEndpoint, relayServerUrl].map(parseHost).filter(Boolean);
  const hostedDefaults = hosts.length === 0 || hosts.every((host) => isHostedHost(host));

  return {
    machineId: input.machineId,
    daemonVersion: input.daemonVersion,
    runtimeKind,
    daemonHome,
    daemonHomeScope: projectConfigDir ? 'project-override' : 'global',
    daemonHomeSource,
    profile: daemonConfig?.profile,
    serverUrl,
    relayEndpoint,
    relayServerUrl,
    relayWorkspaceId: daemonConfig?.relay?.workspaceId,
    hostedDefaults,
  };
}

export function toInstallCapabilities(identity: DaemonRuntimeIdentity): InstallCapabilities {
  return {
    runtime: {
      daemonVersion: identity.daemonVersion,
      runtimeKind: identity.runtimeKind,
      daemonHomeScope: identity.daemonHomeScope,
      profile: identity.profile,
      serverUrl: identity.serverUrl,
      relayEndpoint: identity.relayEndpoint,
      relayServerUrl: identity.relayServerUrl,
    },
  };
}

export function formatRuntimeKindLabel(kind: DaemonRuntimeKind): string {
  switch (kind) {
    case 'managed':
      return 'Managed';
    case 'local-dev':
      return 'Local dev';
    case 'self-hosted':
      return 'Self-hosted';
    default:
      return kind;
  }
}

export function formatDaemonHomeLabel(identity: DaemonRuntimeIdentity): string {
  const relativeHome = path.relative(process.cwd(), identity.daemonHome);
  return relativeHome && !relativeHome.startsWith('..') && !path.isAbsolute(relativeHome)
    ? relativeHome
    : identity.daemonHome;
}
