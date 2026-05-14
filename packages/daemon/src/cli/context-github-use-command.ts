import { getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { useGitHubContextProvider } from '../config-resolution/config-writer.js';

export async function contextGitHubUse(): Promise<void> {
  const repo = requiredFlag(
    'repo',
    'vpd context use-github --repo <owner/repo|url> [--provider <id>] [--path <repo>]',
  );
  const workingDirectory = getFlag('path') ?? getFlag('cwd') ?? process.cwd();
  const result = await useGitHubContextProvider({
    workingDirectory,
    repo,
    remote: getFlag('remote'),
    ref: getFlag('ref') ?? getFlag('branch') ?? 'main',
    branch: getFlag('branch') ?? getFlag('ref') ?? 'main',
    providerId: getFlag('provider') ?? getFlag('id'),
    required: !hasFlag('optional'),
    paths: parsePaths(getFlag('paths')),
    useWhen: getFlag('use-when') ?? getFlag('useWhen'),
    updateWhen: getFlag('update-when') ?? getFlag('updateWhen'),
  });
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  const createCommand =
    repo.includes('://') || repo.startsWith('git@')
      ? undefined
      : `gh repo create ${repo} --private --clone`;

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_use_github/v1',
      command: 'context use-github',
      ok: true,
      config_path: result.configPath,
      changed: result.changed,
      provider: result.provider,
      local_setup: {
        create_repo_command: createCommand,
        propose_command: `vpd context propose --provider ${result.provider.id} --title "Update context" --body "..."`,
      },
      manifest,
    });
    return;
  }

  console.log(`${result.changed ? 'Attached' : 'Already attached'} GitHub context ${repo}`);
  console.log(`Config:   ${result.configPath}`);
  console.log(`Provider: ${result.provider.id}`);
  console.log(`Ref:      ${result.provider.ref}`);
  console.log(`Paths:    ${result.provider.paths.join(', ')}`);
  if (createCommand) {
    console.log('');
    console.log('If the repo does not exist yet, create it from your trusted edge:');
    console.log(`  ${createCommand}`);
  }
  console.log('');
  console.log('Propose an update as a PR:');
  console.log(
    `  vpd context propose --provider ${result.provider.id} --title "Update context" --body "..."`,
  );
  console.log(`Manifest: ${manifest.manifestDigest}`);
}

function parsePaths(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requiredFlag(name: string, usage: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(`${usage} (missing --${name})`);
  }
  return value;
}
