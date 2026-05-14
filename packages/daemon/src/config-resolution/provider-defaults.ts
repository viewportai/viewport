import type {
  ViewportContextProviderCapability,
  ViewportContextProviderKind,
  ViewportContextProviderPrivacy,
} from './types.js';

export function defaultPrivacy(kind: ViewportContextProviderKind): ViewportContextProviderPrivacy {
  if (kind === 'repo-docs') return 'local_only';
  if (kind === 'viewport-vault') return 'control_plane_blind';
  if (kind === 'github-repo') return 'third_party_terms';
  if (kind === 'custom-cli' || kind === 'custom-mcp') return 'unknown';
  return 'third_party_terms';
}

export function defaultCapabilities(
  kind: ViewportContextProviderKind,
): ViewportContextProviderCapability[] {
  if (kind === 'repo-docs') return ['search', 'get'];
  if (kind === 'viewport-vault') return ['search', 'get', 'propose', 'write_approved'];
  if (kind === 'github-repo') return ['search', 'get', 'propose'];
  if (kind === 'custom-cli' || kind === 'custom-mcp') return ['search'];
  return ['search', 'get'];
}
