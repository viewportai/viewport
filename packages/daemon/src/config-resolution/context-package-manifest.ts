import type { SessionContextPackageManifest, ViewportResourceRef } from './types.js';

export function manifestContextPackages(
  refsByConfig: ViewportResourceRef[][],
): SessionContextPackageManifest[] {
  const packages = new Map<string, SessionContextPackageManifest>();
  for (const refs of refsByConfig) {
    for (const ref of refs) {
      if (packages.has(ref.id)) continue;
      const channel = ref.id.includes('@') ? ref.id.split('@').slice(-1)[0] : undefined;
      const contextPackage: SessionContextPackageManifest = {
        id: ref.id,
        required: ref.required,
        sourceConfigPath: ref.sourceConfigPath,
        resource: ref.id.replace(/@(latest-approved|draft|\d+\.x|\d+\.\d+\.\d+)$/, ''),
        resolution: 'requested_unverified',
      };
      if (channel) {
        contextPackage.channel = channel;
      }
      packages.set(ref.id, contextPackage);
    }
  }
  return [...packages.values()];
}
