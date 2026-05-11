import type { RelayLaunchBinding } from './supervisor-protocol.js';
import { createRelayMachineId } from './relay-binding-config.js';

export function resolveRelayLaunchBindings(input: {
  configured:
    | Array<{
        enabled?: boolean;
        endpoint?: string;
        serverUrl?: string;
        workspaceId?: string;
        runtimeTargetId?: string;
        machineId?: string;
        issueToken?: string;
        tlsVerify?: 'auto' | '0' | '1';
        caCertPath?: string;
        tlsPins?: string[];
        tokenIssuer?: string;
        tokenAudience?: string;
        tokenJwksUrl?: string;
        signingKeys?: Record<string, string>;
        tokenClockSkewSec?: number;
      }>
    | undefined;
  computed: RelayLaunchBinding;
}): RelayLaunchBinding[] | undefined {
  if (input.configured && input.configured.length > 0) {
    return input.configured.map((binding) => ({
      enabled: binding.enabled,
      endpoint: binding.endpoint,
      serverUrl: binding.serverUrl,
      workspaceId: binding.workspaceId,
      runtimeTargetId: binding.runtimeTargetId,
      machineId: binding.machineId ?? createRelayMachineId(),
      issueToken: binding.issueToken,
      tlsVerify: binding.tlsVerify,
      caCertPath: binding.caCertPath,
      tlsPins: binding.tlsPins,
      tokenIssuer: binding.tokenIssuer,
      tokenAudience: binding.tokenAudience,
      tokenJwksUrl: binding.tokenJwksUrl,
      tokenSigningKeys: binding.signingKeys,
      tokenClockSkewSec: binding.tokenClockSkewSec,
    }));
  }
  if (
    input.computed.endpoint ||
    input.computed.serverUrl ||
    input.computed.workspaceId ||
    input.computed.issueToken
  ) {
    return [{ ...input.computed, machineId: input.computed.machineId ?? createRelayMachineId() }];
  }
  return undefined;
}
