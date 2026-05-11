import type { ViewportConfig } from '../core/config.js';

export type RelayConfig = NonNullable<NonNullable<ViewportConfig['daemon']>['relay']>;
export type RelayBindingConfig = NonNullable<RelayConfig['bindings']>[number];

export function seedRelayBindings(relayConfig: RelayConfig): RelayBindingConfig[] {
  const bindings = [...(relayConfig.bindings ?? [])];
  const hasLegacyBinding =
    relayConfig.workspaceId ||
    relayConfig.endpoint ||
    relayConfig.serverUrl ||
    relayConfig.issueToken;
  if (!hasLegacyBinding) return bindings;
  const alreadySeeded = bindings.some(
    (binding) =>
      binding.workspaceId === relayConfig.workspaceId &&
      binding.serverUrl === relayConfig.serverUrl,
  );
  if (!alreadySeeded) {
    bindings.unshift({
      enabled: relayConfig.enabled,
      endpoint: relayConfig.endpoint,
      serverUrl: relayConfig.serverUrl,
      workspaceId: relayConfig.workspaceId,
      installId: relayConfig.installId,
      runtimeTargetId: relayConfig.runtimeTargetId,
      machineId: relayConfig.machineId,
      machineName: relayConfig.machineName,
      issueToken: relayConfig.issueToken,
      tlsVerify: relayConfig.tlsVerify,
      caCertPath: relayConfig.caCertPath,
      tlsPins: relayConfig.tlsPins,
      tokenIssuer: relayConfig.tokenIssuer,
      tokenAudience: relayConfig.tokenAudience,
      tokenJwksUrl: relayConfig.tokenJwksUrl,
      signingKeys: relayConfig.signingKeys,
      tokenClockSkewSec: relayConfig.tokenClockSkewSec,
    });
  }
  return bindings;
}

export function upsertRelayBinding(
  bindings: RelayBindingConfig[],
  next: RelayBindingConfig,
  replaceExisting: boolean,
  messagePrefix = 'Remote relay',
): RelayBindingConfig[] {
  const exactIndex = bindings.findIndex(
    (binding) => binding.workspaceId === next.workspaceId && binding.serverUrl === next.serverUrl,
  );
  if (exactIndex >= 0) {
    const copy = [...bindings];
    copy[exactIndex] = { ...copy[exactIndex], ...next };
    return copy;
  }

  const workspaceIndex = bindings.findIndex((binding) => binding.workspaceId === next.workspaceId);
  if (workspaceIndex >= 0 && !replaceExisting) {
    throw new Error(
      `${messagePrefix} already has a binding for workspace ${next.workspaceId}. Re-run with --replace to replace that binding.`,
    );
  }
  if (workspaceIndex >= 0) {
    const copy = [...bindings];
    copy[workspaceIndex] = next;
    return copy;
  }

  return [...bindings, next];
}
