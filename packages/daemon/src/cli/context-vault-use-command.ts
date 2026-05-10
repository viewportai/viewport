import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { useViewportVaultProvider } from '../config-resolution/config-writer.js';

export async function contextVaultUse(): Promise<void> {
  const vaultId = getArgs()[2] ?? getFlag('vault') ?? getFlag('context');
  if (!vaultId || vaultId.startsWith('--')) {
    throw new Error('vpd context use requires <vault_id> or --vault <vault_id>');
  }
  const workingDirectory = getFlag('path') ?? getFlag('cwd') ?? process.cwd();
  const result = await useViewportVaultProvider({
    workingDirectory,
    vaultId,
    providerId: getFlag('provider') ?? getFlag('id'),
    required: !hasFlag('optional'),
  });
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_use/v1',
      command: 'context use',
      ok: true,
      config_path: result.configPath,
      changed: result.changed,
      provider: result.provider,
      manifest,
    });
    return;
  }

  console.log(`${result.changed ? 'Attached' : 'Already attached'} Context Vault ${vaultId}`);
  console.log(`Config:   ${result.configPath}`);
  console.log(`Provider: ${result.provider.id}`);
  console.log(`Manifest: ${manifest.manifestDigest}`);
}
