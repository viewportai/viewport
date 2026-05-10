export const VIEWPORT_CONFIG_FILE = '.viewport/config.yaml';
export const VIEWPORT_LEGACY_CONFIG_FILE = '.viewport/config.json';
export const VIEWPORT_CONFIG_FILES = [VIEWPORT_CONFIG_FILE, VIEWPORT_LEGACY_CONFIG_FILE] as const;
export const SESSION_RESOURCE_MANIFEST_SCHEMA = 'viewport.session_resource_manifest/v1';

export type ViewportResourceKind = 'contexts' | 'workflows' | 'plans' | 'agentProfiles';

export interface ViewportResourceRef {
  id: string;
  required: boolean;
  sourceConfigPath: string;
}

export interface ViewportConfigDefaults {
  inboxRoute?: string;
  visibility?: 'private' | 'team' | 'organization';
  contextCandidateReview?: string;
}

export interface ViewportConfigScope {
  includeChildren?: boolean;
  maxDepth?: number;
  exclude?: string[];
}

export type ViewportContextProviderKind =
  | 'repo-docs'
  | 'viewport-vault'
  | 'notebooklm'
  | 'glean'
  | 'custom-cli'
  | 'custom-mcp';

export type ViewportContextProviderCapability = 'search' | 'get' | 'propose' | 'write_approved';

export type ViewportContextProviderPrivacy =
  | 'local_only'
  | 'control_plane_blind'
  | 'third_party_terms'
  | 'customer_hosted'
  | 'unknown';

export interface ViewportContextProviderRef {
  id: string;
  provider: ViewportContextProviderKind;
  required: boolean;
  privacy: ViewportContextProviderPrivacy;
  capabilities: ViewportContextProviderCapability[];
  sourceConfigPath: string;
  credentialRef?: string;
  vault?: string;
  paths?: string[];
  notebook?: string;
  command?: string;
}

export interface ViewportContextResolution {
  order?: string[];
  sizeBudgetBytes?: number;
  strategy?: 'rank_by_recency_then_query' | 'pinned_then_recent' | 'provider_order';
  proposeFallbackProvider?: string;
}

export interface ViewportWorkflowRef {
  id: string;
  required: boolean;
  sourceConfigPath: string;
  path?: string;
  resource?: string;
  version?: string;
  digest?: string;
}

export interface ViewportRiskyPathRule {
  id: string;
  path: string;
  require: string[];
  checks: string[];
  sourceConfigPath: string;
}

export interface ParsedViewportConfig {
  path: string;
  digest: string;
  version: 1;
  name?: string;
  resources: Record<ViewportResourceKind, ViewportResourceRef[]>;
  contract: {
    contextProviders: ViewportContextProviderRef[];
    contextResolution: ViewportContextResolution;
    workflows: ViewportWorkflowRef[];
    riskyPathRules: ViewportRiskyPathRule[];
  };
  defaults: ViewportConfigDefaults;
  scope: ViewportConfigScope;
}

export interface SessionResourceManifestConfigSource {
  path: string;
  digest: string;
  version: 1;
  name?: string;
}

export interface SessionResourceManifestResource {
  id: string;
  required: boolean;
  sourceConfigPath: string;
  resolution: 'requested_unverified';
}

export interface SessionContextProviderManifest extends ViewportContextProviderRef {
  resolution: 'requested_unverified';
}

export interface SessionWorkflowManifest extends ViewportWorkflowRef {
  resolution: 'requested_unverified';
}

export interface SessionResourceConflict {
  field: string;
  values: Array<{
    value: string;
    sourceConfigPath: string;
  }>;
  resolution: 'requires_user_selection';
}

export interface SessionResourceWarning {
  code:
    | 'no_config_found'
    | 'multiple_configs_found'
    | 'too_many_configs_found'
    | 'invalid_config_skipped';
  message: string;
  path?: string;
}

export interface SessionResourceManifest {
  schema: typeof SESSION_RESOURCE_MANIFEST_SCHEMA;
  manifestDigest: string;
  workingDirectory: string;
  configSources: SessionResourceManifestConfigSource[];
  resources: Record<ViewportResourceKind, SessionResourceManifestResource[]>;
  contract: {
    contextProviders: SessionContextProviderManifest[];
    contextResolution: ViewportContextResolution;
    workflows: SessionWorkflowManifest[];
    riskyPathRules: ViewportRiskyPathRule[];
  };
  conflicts: SessionResourceConflict[];
  warnings: SessionResourceWarning[];
}
