import type { RelayStatusPayload } from './types.js';

export function runtimeScopeKey(workspaceId: string, runtimeTargetId?: string): string {
  return runtimeTargetId ? `${workspaceId}:${runtimeTargetId}` : workspaceId;
}

export function relayStatusPayload(
  workspaceId: string,
  runtimeTargetId?: string,
  machineId?: string,
): RelayStatusPayload {
  const payload: RelayStatusPayload = {
    type: 'relay_status',
    code: 'DAEMON_UNAVAILABLE',
    message: 'No machine runtime is connected for this runtime target',
    workspaceId,
    retryable: true,
  };
  if (runtimeTargetId) payload.runtimeTargetId = runtimeTargetId;
  if (machineId) payload.machineId = machineId;
  return payload;
}

export function missingRuntimeTargetPayload(workspaceId: string): RelayStatusPayload {
  return {
    type: 'relay_status',
    code: 'RUNTIME_TARGET_REQUIRED',
    message: 'Runtime client must specify a runtime target',
    workspaceId,
    retryable: false,
  };
}

export function relayRedirectPayload(
  workspaceId: string,
  relayWsBaseUrl: string,
  runtimeTargetId?: string,
): RelayStatusPayload {
  return {
    type: 'relay_status',
    code: 'RELAY_REDIRECT',
    message: 'Workspace is assigned to a different relay instance',
    workspaceId,
    runtimeTargetId,
    relayWsBaseUrl,
  };
}
