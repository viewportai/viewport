export const VIEWPORT_CONFIG_FILE = '.viewport/config.json';
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

export interface ParsedViewportConfig {
  path: string;
  digest: string;
  version: 1;
  name?: string;
  resources: Record<ViewportResourceKind, ViewportResourceRef[]>;
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
  conflicts: SessionResourceConflict[];
  warnings: SessionResourceWarning[];
}
