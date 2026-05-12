import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';

const GENERATED_MARKER = '<!-- viewport-generated-context-rule -->';

export async function contextRulesInstall(): Promise<void> {
  const workingDirectory = path.resolve(getFlag('path') ?? getFlag('cwd') ?? process.cwd());
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  const repoRoot = repoRootFromManifest(manifest, workingDirectory);
  const targetPath = path.join(repoRoot, '.claude', 'rules', 'viewport-context.md');
  const hasContext =
    manifest.contract.contextProviders.length > 0 || manifest.resources.contexts.length > 0;

  if (!hasContext && !hasFlag('force')) {
    const output = {
      schema_version: 'viewport.cli.context_rules_install/v1',
      command: 'context rules install',
      ok: true,
      installed: false,
      reason: 'no_context_contract',
      path: targetPath,
      manifest_digest: manifest.manifestDigest,
    };
    if (isJsonMode()) {
      printJson(output);
      return;
    }
    console.log('No Viewport context contract found for this repo.');
    return;
  }

  const existing = await readIfExists(targetPath);
  if (existing !== undefined && !existing.includes(GENERATED_MARKER) && !hasFlag('force')) {
    throw new Error(
      `Refusing to overwrite non-Viewport Claude rule: ${targetPath}. Re-run with --force to replace it.`,
    );
  }

  const content = renderRule(manifest.manifestDigest);
  const changed = existing !== content;
  if (changed) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, 'utf8');
  }

  const output = {
    schema_version: 'viewport.cli.context_rules_install/v1',
    command: 'context rules install',
    ok: true,
    installed: true,
    changed,
    path: targetPath,
    manifest_digest: manifest.manifestDigest,
  };
  if (isJsonMode()) {
    printJson(output);
    return;
  }
  console.log(`${changed ? 'Installed' : 'Already installed'} Claude context rule: ${targetPath}`);
}

function repoRootFromManifest(
  manifest: { configSources: Array<{ path: string }> },
  fallback: string,
): string {
  const configPath = manifest.configSources[0]?.path;
  if (!configPath) return fallback;
  const parent = path.dirname(configPath);
  if (path.basename(parent) === '.viewport') return path.dirname(parent);
  return parent;
}

function renderRule(manifestDigest: string): string {
  return [
    GENERATED_MARKER,
    '# Viewport context',
    '',
    'This repo has a Viewport context contract.',
    '',
    '- Use context injected by the Viewport daemon when it appears in the conversation.',
    '- When more context is needed, run `vpd context search --path . --query "<topic>" --json`.',
    '- Fetch exact entries with `vpd context get <entry-id> --path . --json`.',
    '- If you learn something durable that should be shared with the team, ask the user once before running `vpd context propose --path . --title "<title>" --body "<body>" --json`.',
    '- Do not propose secrets, credentials, private customer data, or one-off task chatter.',
    '- Context proposals are pending until reviewed in Viewport Inbox. Treat pending local context as author-local working memory, not approved team policy.',
    '',
    `Manifest digest at install time: ${manifestDigest}`,
    '',
  ].join('\n');
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
