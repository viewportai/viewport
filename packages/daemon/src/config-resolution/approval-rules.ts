import type { ViewportConfigInput } from './schema.js';
import type { ParsedViewportConfig, ViewportRiskyPathRule } from './types.js';

export function normalizeRiskyPathRules(
  sourceConfigPath: string,
  approvals: ViewportConfigInput['approvals'],
): ViewportRiskyPathRule[] {
  const riskyPaths = approvals?.risky_paths ?? approvals?.riskyPaths ?? [];
  return riskyPaths.map((rule, index) => ({
    id: rule.id ?? `risky-path-${index + 1}`,
    path: rule.path,
    require: rule.require,
    checks: rule.checks ?? [],
    sourceConfigPath,
  }));
}

export function manifestRiskyPathRules(configs: ParsedViewportConfig[]): ViewportRiskyPathRule[] {
  return configs.flatMap((config) => config.contract.riskyPathRules);
}
