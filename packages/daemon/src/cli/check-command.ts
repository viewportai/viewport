import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { ZodSchema } from 'zod';
import { PolicyDocumentSchema, RouteConfigDocumentSchema } from './policy-schema-validator.js';
import { getArgs, hasFlag } from './args.js';

interface CheckResult {
  file: string;
  valid: boolean;
  errors: string[];
  summary?: string;
}

interface CheckOutput {
  valid: boolean;
  results: CheckResult[];
  errorCount: number;
  warnings: string[];
  warningCount: number;
}

export async function check(): Promise<void> {
  const args = getArgs();
  const jsonMode = hasFlag('json');

  // `vpd check [path]` — path is the second positional arg (after 'check')
  const targetPath = (args[1] && !args[1].startsWith('-') ? args[1] : null) ?? '.';
  const viewportDir = path.resolve(targetPath, '.viewport');

  if (!fs.existsSync(viewportDir)) {
    const msg = `No .viewport/ directory found at ${path.resolve(targetPath)}`;
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ valid: false, error: msg }) + '\n');
    } else {
      process.stderr.write(`✗ ${msg}\n`);
    }
    process.exit(1);
  }

  const results: CheckResult[] = [];

  // policy.yaml
  const policyPath = path.join(viewportDir, 'policy.yaml');
  if (fs.existsSync(policyPath)) {
    results.push(checkFile(policyPath, 'policy.yaml', PolicyDocumentSchema));
  }

  // routes/*.yaml
  const routesDir = path.join(viewportDir, 'routes');
  if (fs.existsSync(routesDir) && fs.statSync(routesDir).isDirectory()) {
    for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.yaml'))) {
      results.push(
        checkFile(path.join(routesDir, file), `routes/${file}`, RouteConfigDocumentSchema),
      );
    }
  }

  // access.yaml — present but not yet validated (Phase 11 adds the schema)
  const accessPath = path.join(viewportDir, 'access.yaml');
  if (fs.existsSync(accessPath)) {
    results.push(validateAccessYaml(accessPath));
  }

  const output: CheckOutput = {
    valid: results.length > 0 && results.every((r) => r.valid),
    results,
    errorCount: results.filter((r) => !r.valid).length,
    warnings: gitIgnoreWarnings(path.resolve(targetPath)),
    warningCount: 0,
  };
  output.warningCount = output.warnings.length;

  if (results.length === 0) {
    output.valid = false;
    const emptyMsg = 'No .viewport/ files found (expected policy.yaml, routes/*.yaml)';
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ valid: false, error: emptyMsg }) + '\n');
    } else {
      process.stderr.write(`✗ ${emptyMsg}\n`);
    }
    process.exit(1);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    printHumanOutput(output, path.resolve(targetPath));
  }

  process.exit(output.valid ? 0 : 1);
}

function checkFile(fullPath: string, displayName: string, schema: ZodSchema): CheckResult {
  let content: unknown;
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    content = parseYaml(raw);
  } catch (e: unknown) {
    return {
      file: displayName,
      valid: false,
      errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const result = schema.safeParse(content);
  if (result.success) {
    return { file: displayName, valid: true, errors: [], summary: 'valid' };
  }

  const errors = (result.error.issues ?? []).map((issue) => {
    const fieldPath = issue.path.join('.');
    return fieldPath ? `${fieldPath}: ${issue.message}` : issue.message;
  });

  return { file: displayName, valid: false, errors };
}

function validateAccessYaml(fullPath: string): CheckResult {
  // Parse the YAML and do a basic structural check (Phase 11 adds full schema validation).
  let content: unknown;
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    content = parseYaml(raw);
  } catch (e: unknown) {
    return {
      file: 'access.yaml',
      valid: false,
      errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return {
      file: 'access.yaml',
      valid: false,
      errors: ['access.yaml must be a YAML mapping'],
    };
  }

  // Minimum: must have a `grants` key (the only required field in the Phase 11 spec)
  const doc = content as Record<string, unknown>;
  if (!('grants' in doc)) {
    return {
      file: 'access.yaml',
      valid: false,
      errors: ['access.yaml must have a top-level `grants` key'],
    };
  }

  return {
    file: 'access.yaml',
    valid: true,
    errors: [],
    summary: 'structurally valid (full schema pending Phase 11)',
  };
}

function gitIgnoreWarnings(resolvedPath: string): string[] {
  try {
    execFileSync('git', ['-C', resolvedPath, 'check-ignore', '-q', '--no-index', '.viewport'], {
      stdio: 'ignore',
    });

    return [
      '.viewport/ appears to be ignored by git. Declarative GitOps requires committed .viewport/ policy and route files.',
    ];
  } catch {
    return [];
  }
}

function printHumanOutput(output: CheckOutput, resolvedPath: string): void {
  process.stdout.write(`Checking .viewport/ in ${resolvedPath}\n\n`);

  for (const result of output.results) {
    if (result.valid) {
      process.stdout.write(`  ✓ ${result.file.padEnd(30)} ${result.summary ?? 'valid'}\n`);
    } else {
      process.stdout.write(`  ✗ ${result.file.padEnd(30)} ${result.errors.length} error(s)\n`);
      for (const err of result.errors) {
        process.stdout.write(`      ${err}\n`);
      }
    }
  }

  if (output.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const warning of output.warnings) {
      process.stdout.write(`  ! ${warning}\n`);
    }
  }

  process.stdout.write('\n');
  if (output.valid) {
    process.stdout.write(`✓ ${output.results.length} file(s) valid.\n`);
  } else {
    process.stdout.write(
      `✗ ${output.errorCount} file(s) with errors. Fix before deploying to Viewport.\n`,
    );
  }
}
