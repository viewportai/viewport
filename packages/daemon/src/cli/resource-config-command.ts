import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';

export async function config(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showConfigHelp();
    return;
  }
  if (subcommand === 'resolve') {
    await configResolve();
    return;
  }
  if (subcommand === 'doctor') {
    await configDoctor();
    return;
  }
  throw new Error(configUsage());
}

function configUsage(): string {
  return 'Usage: vpd config <resolve|doctor> [--cwd <path>] [--json]';
}

function showConfigHelp(): void {
  console.log(configUsage());
}

async function configResolve(): Promise<void> {
  const workingDirectory = getFlag('cwd') ?? process.cwd();
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });

  if (isJsonMode()) {
    printJson({ command: 'config resolve', ok: true, manifest });
    return;
  }

  const resourceCount =
    manifest.resources.contexts.length +
    manifest.resources.workflows.length +
    manifest.resources.plans.length +
    manifest.resources.agentProfiles.length;

  console.log('Viewport config manifest');
  console.log(`Working dir: ${manifest.workingDirectory}`);
  console.log(`Digest:      ${manifest.manifestDigest}`);
  console.log(`Configs:     ${manifest.configSources.length}`);
  console.log(`Resources:   ${resourceCount}`);

  for (const source of manifest.configSources) {
    console.log(`  - ${source.path}`);
  }
  printResources('Contexts', manifest.resources.contexts);
  printResources('Workflows', manifest.resources.workflows);
  printResources('Plans', manifest.resources.plans);
  printResources('Agent profiles', manifest.resources.agentProfiles);
  for (const warning of manifest.warnings) {
    console.log(`Warning: ${warning.code} - ${warning.message}`);
  }
  for (const conflict of manifest.conflicts) {
    console.log(`Conflict: ${conflict.field} requires user selection`);
  }
}

async function configDoctor(): Promise<void> {
  const workingDirectory = getFlag('cwd') ?? process.cwd();
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  const ok = manifest.configSources.length > 0 && manifest.conflicts.length === 0;

  if (isJsonMode()) {
    printJson({
      command: 'config doctor',
      ok,
      status: ok ? 'ready' : 'needs_attention',
      manifest,
    });
    return;
  }

  console.log('Viewport config doctor');
  console.log(`Working dir: ${manifest.workingDirectory}`);
  console.log(`Status:      ${ok ? 'ready' : 'needs attention'}`);
  console.log(`Configs:     ${manifest.configSources.length}`);
  if (manifest.configSources.length === 0) {
    console.log('No repo-local .viewport/config.json was found.');
  }
  for (const source of manifest.configSources) {
    console.log(`  - ${source.path}`);
  }
  printResources('Contexts', manifest.resources.contexts);
  printResources('Workflows', manifest.resources.workflows);
  printResources('Plans', manifest.resources.plans);
  printResources('Agent profiles', manifest.resources.agentProfiles);
  for (const warning of manifest.warnings) {
    console.log(`Warning: ${warning.code} - ${warning.message}`);
  }
  for (const conflict of manifest.conflicts) {
    console.log(`Conflict: ${conflict.field} requires user selection`);
  }
}

function printResources(
  label: string,
  resources: Array<{ id: string; required: boolean; sourceConfigPath: string }>,
): void {
  if (resources.length === 0) return;
  console.log(`${label}:`);
  for (const resource of resources) {
    console.log(`  - ${resource.id}${resource.required ? ' (required)' : ''}`);
  }
}
