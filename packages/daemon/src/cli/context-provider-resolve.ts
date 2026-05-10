import {
  resolveSessionResourceManifestSync,
  type SessionContextProviderManifest,
  type SessionResourceManifest,
} from '../config-resolution/index.js';

export interface WritableViewportVaultProvider {
  contextResourceId: string;
  manifest: SessionResourceManifest;
  provider: SessionContextProviderManifest;
}

export function resolveWritableViewportVaultProvider(options: {
  providerId: string;
  workingDirectory: string;
}): WritableViewportVaultProvider {
  const manifest = resolveSessionResourceManifestSync({
    workingDirectory: options.workingDirectory,
  });
  const provider = manifest.contract.contextProviders.find(
    (candidate) => candidate.id === options.providerId,
  );
  if (!provider) {
    throw new Error(`Context provider not found in resolved contract: ${options.providerId}`);
  }
  if (provider.provider !== 'viewport-vault' || !provider.vault) {
    throw new Error(`Context provider ${provider.id} is not a writable viewport-vault provider.`);
  }
  if (!provider.capabilities.includes('write_approved')) {
    throw new Error(`Context provider ${provider.id} does not support approved context writes.`);
  }
  return {
    contextResourceId: provider.vault,
    manifest,
    provider,
  };
}
