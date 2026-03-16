/**
 * Permission resolution engine.
 *
 * Resolves whether a tool call should be auto-approved, require user approval,
 * or be denied — based on the layered PermissionsConfig.
 *
 * For v0.1: tool name matching only. Future: semantic Bash command matching,
 * path-based rules, etc.
 */

import type { PermissionsConfig } from '../core/types.js';
import { metrics } from '../core/metrics.js';

export type PermissionResolution = 'auto-approve' | 'require-approval' | 'deny';

/**
 * Resolve the permission for a tool call.
 *
 * Priority: deny > autoApprove > requireApproval > default (require-approval)
 */
export function resolvePermission(
  toolName: string,
  _toolInput: Record<string, unknown> | undefined,
  config: PermissionsConfig,
): PermissionResolution {
  // Deny takes highest priority
  if (config.deny.includes(toolName)) {
    metrics.increment('permissions.denied');
    return 'deny';
  }

  // Auto-approve if listed
  if (config.autoApprove.includes(toolName)) {
    metrics.increment('permissions.auto_approved');
    return 'auto-approve';
  }

  // Explicitly require approval if listed
  if (config.requireApproval.includes(toolName)) {
    metrics.increment('permissions.require_approval');
    return 'require-approval';
  }

  // Default: require approval for unknown tools
  metrics.increment('permissions.require_approval');
  return 'require-approval';
}

/**
 * Check if a tool name matches any pattern in a list.
 * For v0.1: exact match only. Future: glob/regex patterns.
 */
export function matchesTool(toolName: string, patterns: string[]): boolean {
  return patterns.includes(toolName);
}
