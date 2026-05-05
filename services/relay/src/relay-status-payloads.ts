import type { RelayStatusPayload } from './types.js';

export function runtimeScopeKey(workspaceId: string, projectMachineBindingId?: string): string {
  return projectMachineBindingId ? `${workspaceId}:${projectMachineBindingId}` : workspaceId;
}

export function relayStatusPayload(
  workspaceId: string,
  projectMachineBindingId?: string,
  machineId?: string,
): RelayStatusPayload {
  const payload: RelayStatusPayload = {
    type: 'relay_status',
    code: 'DAEMON_UNAVAILABLE',
    message: 'No machine runtime is connected for this project target',
    workspaceId,
    retryable: true,
  };
  if (projectMachineBindingId) payload.projectMachineBindingId = projectMachineBindingId;
  if (machineId) payload.machineId = machineId;
  return payload;
}

export function missingRuntimeTargetPayload(workspaceId: string): RelayStatusPayload {
  return {
    type: 'relay_status',
    code: 'MISSING_PROJECT_MACHINE_BINDING',
    message: 'Runtime client must specify a project-machine binding target',
    workspaceId,
    retryable: false,
  };
}

export function relayRedirectPayload(
  workspaceId: string,
  relayWsBaseUrl: string,
  projectMachineBindingId?: string,
): RelayStatusPayload {
  return {
    type: 'relay_status',
    code: 'RELAY_REDIRECT',
    message: 'Workspace is assigned to a different relay instance',
    workspaceId,
    projectMachineBindingId,
    relayWsBaseUrl,
  };
}
