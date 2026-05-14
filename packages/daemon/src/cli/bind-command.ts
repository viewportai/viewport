import path from 'node:path';
import { ConfigManager } from '../core/config.js';
import { activeProfileName } from '../core/profiles.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  localBindingPath,
  resolveLocalOrgBindingSync,
  resolveWorkspaceOrgHintSync,
  writeLocalOrgBinding,
} from './org-binding.js';

function usage(): string {
  return 'Usage: vpd bind [path] [--org <organization-id>] [--yes|--force] [--json]';
}

function currentRelayOrganizationId(manager: ConfigManager): string | undefined {
  return manager.getDaemonConfig()?.relay?.workspaceId;
}

export async function bind(): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const targetArg = args[1] && !args[1].startsWith('--') ? args[1] : '.';
  const directory = path.resolve(targetArg);
  const manager = new ConfigManager();
  await manager.load();
  const explicitOrg = getFlag('org') ?? getFlag('organization') ?? getFlag('workspace');
  const hint = resolveWorkspaceOrgHintSync(directory);
  const orgId = explicitOrg ?? hint?.organizationId ?? currentRelayOrganizationId(manager);
  if (!orgId) {
    throw new Error(
      `${usage()}\nNo organization ID was provided, no .viewport/workspace.yaml hint was found, and this daemon is not paired.`,
    );
  }

  const current = resolveLocalOrgBindingSync(directory);
  const profileName = activeProfileName() ?? 'default';
  const replacing =
    current && (current.organizationId !== orgId || current.profileName !== profileName);
  const force = hasFlag('yes') || hasFlag('force');
  if (replacing && !force) {
    throw new Error(
      `Directory is already bound to ${current.organizationId} using profile "${current.profileName}". Re-run with --yes to replace it with ${orgId} using profile "${profileName}".`,
    );
  }

  const binding = await writeLocalOrgBinding({ directory, organizationId: orgId, profileName });
  const payload = {
    command: 'bind',
    ok: true,
    directory: binding.directory,
    localConfig: binding.filePath,
    organizationId: binding.organizationId,
    profileName: binding.profileName,
    streamEnabled: binding.streamEnabled,
    replaced: Boolean(replacing),
    hint: hint
      ? {
          organizationId: hint.organizationId,
          filePath: hint.filePath,
        }
      : null,
    gitignore: path.join(binding.directory, '.viewport', '.gitignore'),
  };

  if (asJson) {
    printJson(payload);
    return;
  }

  console.log(`Bound ${binding.directory} to ${binding.organizationId}.`);
  console.log(`Profile: ${binding.profileName}`);
  console.log(`Local config: ${binding.filePath}`);
  console.log('Remote streaming is enabled for this directory and its children.');
  console.log(`Gitignored local binding: ${localBindingPath(binding.directory)}`);
}
