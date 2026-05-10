import path from 'node:path';
import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  resolveSessionResourceManifestSync,
  type SessionResourceManifest,
  type ViewportRiskyPathRule,
} from '../config-resolution/index.js';

type GuardAction = 'edit' | 'delete' | 'create' | 'run' | 'read';
type GuardDecision = 'allowed' | 'requires_approval' | 'contract_invalid';

interface MatchedApprovalRule {
  id: string;
  source: string;
  path: string;
  require: string[];
  checks: string[];
  reviewers: string[];
}

interface GuardCheckResult {
  schema_version: 'viewport.cli.guard_check/v1';
  command: 'guard check';
  ok: boolean;
  path: string;
  absolute_path: string;
  action: GuardAction | string;
  risk: 'low' | 'high' | 'unknown';
  decision: GuardDecision;
  manifest_digest: string;
  approval_rules: MatchedApprovalRule[];
  warnings: SessionResourceManifest['warnings'];
  errors: Array<Record<string, unknown>>;
}

export async function guard(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showGuardHelp();
    return;
  }
  if (subcommand === 'check') {
    await guardCheck();
    return;
  }
  throw new Error(guardUsage());
}

function guardUsage(): string {
  return 'Usage: vpd guard check --path <file> [--action edit|delete|create|run|read] [--cwd <repo>] [--json]';
}

function showGuardHelp(): void {
  console.log(guardUsage());
}

async function guardCheck(): Promise<void> {
  const targetPath = getFlag('path');
  if (!targetPath) {
    throw new Error(guardUsage());
  }

  const workingDirectory = path.resolve(getFlag('cwd') ?? process.cwd());
  const absoluteTargetPath = path.resolve(workingDirectory, targetPath);
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  const action = getFlag('action') ?? 'edit';
  const result = buildGuardCheckResult({
    manifest,
    targetPath,
    absoluteTargetPath,
    action,
  });

  if (isJsonMode()) {
    printJson(result);
  } else {
    printGuardCheck(result);
  }

  if (!result.ok) {
    throw new Error(
      result.decision === 'requires_approval'
        ? `Viewport guard requires approval for ${targetPath}`
        : 'Viewport guard could not validate the repo contract',
    );
  }
}

export function buildGuardCheckResult(input: {
  manifest: SessionResourceManifest;
  targetPath: string;
  absoluteTargetPath: string;
  action: string;
}): GuardCheckResult {
  const invalidWarnings = input.manifest.warnings.filter(
    (warning) => warning.code === 'invalid_config_skipped',
  );
  const errors = [
    ...input.manifest.conflicts.map((conflict) => ({
      code: 'contract_conflict',
      field: conflict.field,
      resolution: conflict.resolution,
      values: conflict.values,
    })),
    ...invalidWarnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.path ? { path: warning.path } : {}),
    })),
  ];

  if (errors.length > 0) {
    return {
      schema_version: 'viewport.cli.guard_check/v1',
      command: 'guard check',
      ok: false,
      path: input.targetPath,
      absolute_path: input.absoluteTargetPath,
      action: input.action,
      risk: 'unknown',
      decision: 'contract_invalid',
      manifest_digest: input.manifest.manifestDigest,
      approval_rules: [],
      warnings: input.manifest.warnings,
      errors,
    };
  }

  const matchedRules = input.manifest.contract.riskyPathRules
    .filter((rule) => ruleMatchesTarget(rule, input.absoluteTargetPath))
    .map(toApprovalRule);

  return {
    schema_version: 'viewport.cli.guard_check/v1',
    command: 'guard check',
    ok: matchedRules.length === 0,
    path: input.targetPath,
    absolute_path: input.absoluteTargetPath,
    action: input.action,
    risk: matchedRules.length > 0 ? 'high' : 'low',
    decision: matchedRules.length > 0 ? 'requires_approval' : 'allowed',
    manifest_digest: input.manifest.manifestDigest,
    approval_rules: matchedRules,
    warnings: input.manifest.warnings,
    errors: [],
  };
}

function ruleMatchesTarget(rule: ViewportRiskyPathRule, absoluteTargetPath: string): boolean {
  const configRoot = path.dirname(path.dirname(rule.sourceConfigPath));
  const relativeTarget = normalizePath(path.relative(configRoot, absoluteTargetPath));
  if (relativeTarget.startsWith('../')) return false;
  return globPatternToRegExp(normalizePath(rule.path)).test(relativeTarget);
}

function toApprovalRule(rule: ViewportRiskyPathRule): MatchedApprovalRule {
  return {
    id: rule.id,
    source: rule.sourceConfigPath,
    path: rule.path,
    require: rule.require,
    checks: rule.checks,
    reviewers: rule.require,
  };
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char ?? '');
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function printGuardCheck(result: GuardCheckResult): void {
  console.log('Viewport guard check');
  console.log(`Path:     ${result.path}`);
  console.log(`Action:   ${result.action}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Risk:     ${result.risk}`);
  if (result.approval_rules.length > 0) {
    console.log('Approval rules:');
    for (const rule of result.approval_rules) {
      console.log(`  - ${rule.id} (${rule.path}) requires ${rule.require.join(', ')}`);
      for (const check of rule.checks) {
        console.log(`    check: ${check}`);
      }
    }
  }
}
