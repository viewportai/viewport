import { getArgs, getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  printAuthorization,
  requestAuthorization,
  resolveAuthorizationTarget,
} from './contract-authorization.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';

type ResolvedManifest = ReturnType<typeof resolveSessionResourceManifestSync>;

export function buildValidateJsonOutput(
  manifest: ResolvedManifest,
  ok: boolean,
): Record<string, unknown> {
  return {
    schema_version: 'viewport.cli.validate/v1',
    command: 'validate',
    ok,
    status: ok ? 'ready' : 'needs_attention',
    path: manifest.workingDirectory,
    config_files: manifest.configSources.map((source) => source.path),
    workflow_files: manifest.contract.workflows
      .map((workflow) => workflow.path)
      .filter((workflowPath): workflowPath is string => typeof workflowPath === 'string'),
    warnings: manifest.warnings,
    errors: [
      ...manifest.conflicts.map((conflict) => ({
        code: 'contract_conflict',
        field: conflict.field,
        resolution: conflict.resolution,
        values: conflict.values,
      })),
      ...manifest.warnings
        .filter((warning) => warning.code === 'invalid_config_skipped')
        .map((warning) => ({
          code: warning.code,
          message: warning.message,
          ...(warning.path ? { path: warning.path } : {}),
        })),
    ],
    manifest,
  };
}

export function buildContractResolveJsonOutput(
  manifest: ResolvedManifest,
): Record<string, unknown> {
  return {
    schema_version: 'viewport.cli.contract_resolve/v1',
    command: 'contract resolve',
    ok: true,
    manifest_digest: manifest.manifestDigest,
    path: manifest.workingDirectory,
    repo: null,
    config_files: manifest.configSources.map((source) => ({
      path: source.path,
      digest: source.digest,
      ...(source.name ? { name: source.name } : {}),
    })),
    workflows: manifest.contract.workflows.map((workflow) => ({
      id: workflow.id,
      source: workflow.path ? 'local_file' : workflow.resource ? 'resource' : 'unresolved',
      ...(workflow.path ? { path: workflow.path } : {}),
      ...(workflow.resource ? { resource: workflow.resource } : {}),
      ...(workflow.digest ? { digest: workflow.digest } : {}),
      required: workflow.required,
      status: 'requested_unverified',
    })),
    providers: manifest.contract.contextProviders.map((provider) => ({
      id: provider.id,
      provider: provider.provider,
      privacy: provider.privacy,
      capabilities: provider.capabilities,
      required: provider.required,
      status: 'available',
      ...(provider.vault ? { vault: provider.vault } : {}),
      ...(provider.paths ? { paths: provider.paths } : {}),
      ...(provider.notebook ? { notebook: provider.notebook } : {}),
      ...(provider.command ? { command: provider.command } : {}),
    })),
    denied: [],
    missing: manifest.warnings
      .filter((warning) => warning.code === 'no_config_found')
      .map((warning) => ({
        code: warning.code,
        message: warning.message,
        ...(warning.path ? { path: warning.path } : {}),
      })),
    conflicts: manifest.conflicts,
    warnings: manifest.warnings,
    errors: [],
    resolver: {
      name: 'vpd-contract-resolver',
      version: '1',
    },
    manifest,
  };
}

export async function validate(): Promise<void> {
  const workingDirectory = getPathFlag();
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  const invalidWarnings = manifest.warnings.filter(
    (warning) => warning.code === 'invalid_config_skipped',
  );
  const ok =
    manifest.configSources.length > 0 &&
    manifest.conflicts.length === 0 &&
    invalidWarnings.length === 0;

  if (isJsonMode()) {
    printJson(buildValidateJsonOutput(manifest, ok));
    return;
  }

  console.log('Viewport contract validation');
  console.log(`Working dir: ${manifest.workingDirectory}`);
  console.log(`Status:      ${ok ? 'ready' : 'needs attention'}`);
  console.log(`Configs:     ${manifest.configSources.length}`);
  printWarningsAndConflicts(manifest);

  if (!ok) {
    throw new Error('Viewport contract validation failed');
  }
}

export async function contract(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showContractHelp();
    return;
  }
  if (subcommand === 'resolve') {
    await contractResolve();
    return;
  }
  if (subcommand === 'authorize') {
    await contractAuthorize();
    return;
  }
  throw new Error(contractUsage());
}

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

function contractUsage(): string {
  return [
    'Usage: vpd contract <command>',
    '',
    'Commands:',
    '  resolve [--path <path>|--cwd <path>] [--json]',
    '  authorize [--path <path>|--cwd <path>] [--workspace <id>] [--server-url <url>] [--credential <token>] [--json]',
  ].join('\n');
}

function showConfigHelp(): void {
  console.log(configUsage());
}

function showContractHelp(): void {
  console.log(contractUsage());
}

async function contractResolve(): Promise<void> {
  const workingDirectory = getPathFlag();
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });

  if (isJsonMode()) {
    printJson(buildContractResolveJsonOutput(manifest));
    return;
  }

  printManifest('Viewport contract manifest', manifest);
}

async function contractAuthorize(): Promise<void> {
  const workingDirectory = getPathFlag();
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  const target = await resolveAuthorizationTarget();
  const authorization = await requestAuthorization(target, manifest);
  const denied = authorization.summary?.denied ?? 0;
  const ok = denied === 0;

  if (isJsonMode()) {
    printJson({
      command: 'contract authorize',
      ok,
      target: {
        serverUrl: target.serverUrl,
        workspaceId: target.workspaceId,
      },
      manifest,
      authorization,
    });
  } else {
    printAuthorization(manifest, authorization, target.workspaceId);
  }

  if (!ok) {
    throw new Error(`Viewport contract authorization denied ${denied} item(s)`);
  }
}

async function configResolve(): Promise<void> {
  const workingDirectory = getFlag('cwd') ?? process.cwd();
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });

  if (isJsonMode()) {
    printJson({ command: 'config resolve', ok: true, manifest });
    return;
  }

  printManifest('Viewport config manifest', manifest);
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
    console.log('No repo-local .viewport/config.yaml was found.');
  }
  for (const source of manifest.configSources) {
    console.log(`  - ${source.path}`);
  }
  printProviders(manifest.contract.contextProviders);
  printWorkflowRefs(manifest.contract.workflows);
  printResources('Contexts', manifest.resources.contexts);
  printResources('Workflows', manifest.resources.workflows);
  printResources('Plans', manifest.resources.plans);
  printResources('Agent profiles', manifest.resources.agentProfiles);
  printWarningsAndConflicts(manifest);
}

function getPathFlag(): string {
  return getFlag('path') ?? getFlag('cwd') ?? process.cwd();
}

function printManifest(title: string, manifest: ResolvedManifest): void {
  const resourceCount =
    manifest.resources.contexts.length +
    manifest.resources.workflows.length +
    manifest.resources.plans.length +
    manifest.resources.agentProfiles.length;

  console.log(title);
  console.log(`Working dir: ${manifest.workingDirectory}`);
  console.log(`Digest:      ${manifest.manifestDigest}`);
  console.log(`Configs:     ${manifest.configSources.length}`);
  console.log(`Resources:   ${resourceCount}`);
  console.log(`Providers:   ${manifest.contract.contextProviders.length}`);
  console.log(`Workflows:   ${manifest.contract.workflows.length}`);

  for (const source of manifest.configSources) {
    console.log(`  - ${source.path}`);
  }
  printProviders(manifest.contract.contextProviders);
  printWorkflowRefs(manifest.contract.workflows);
  printResources('Contexts', manifest.resources.contexts);
  printResources('Workflows', manifest.resources.workflows);
  printResources('Plans', manifest.resources.plans);
  printResources('Agent profiles', manifest.resources.agentProfiles);
  printWarningsAndConflicts(manifest);
}

function printProviders(
  providers: Array<{
    id: string;
    provider: string;
    required: boolean;
    privacy: string;
    capabilities: string[];
  }>,
): void {
  if (providers.length === 0) return;
  console.log('Providers:');
  for (const provider of providers) {
    console.log(
      `  - ${provider.id} (${provider.provider}, ${provider.privacy}, ${provider.capabilities.join(',')})${provider.required ? ' required' : ''}`,
    );
  }
}

function printWorkflowRefs(
  workflows: Array<{
    id: string;
    required: boolean;
    path?: string;
    resource?: string;
  }>,
): void {
  if (workflows.length === 0) return;
  console.log('Workflow refs:');
  for (const workflow of workflows) {
    const target = workflow.path ?? workflow.resource ?? 'unresolved';
    console.log(`  - ${workflow.id} -> ${target}${workflow.required ? ' (required)' : ''}`);
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

function printWarningsAndConflicts(manifest: ResolvedManifest): void {
  for (const warning of manifest.warnings) {
    console.log(`Warning: ${warning.code} - ${warning.message}`);
  }
  for (const conflict of manifest.conflicts) {
    console.log(`Conflict: ${conflict.field} requires user selection`);
  }
}
