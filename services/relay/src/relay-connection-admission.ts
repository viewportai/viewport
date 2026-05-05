import type { AdmissionClaims, RelayRole } from './types.js';

export interface RelayConnectionAdmissionInput {
  role: RelayRole;
  workspaceId: string;
  requestedProjectMachineBindingId?: string;
  ip: string;
  claims?: AdmissionClaims;
}

export type RelayConnectionAdmissionResult =
  | {
      ok: true;
      clientScopeClaim?: AdmissionClaims['scope'];
      projectMachineBindingId?: string;
      machineId?: string;
    }
  | {
      ok: false;
      logEvent: 'connection_rejected' | 'client_connection_rejected';
      reason: string;
      closeReason: string;
      logDetails: Record<string, unknown>;
      sendMissingRuntimeTarget?: boolean;
    };

export function resolveConnectionAdmission(
  input: RelayConnectionAdmissionInput,
): RelayConnectionAdmissionResult {
  const { role, workspaceId, requestedProjectMachineBindingId, ip, claims } = input;
  const clientScopeClaim = claims?.scope;
  const claimedWorkspaceId = typeof claims?.workspaceId === 'string' ? claims.workspaceId.trim() : '';
  if (claimedWorkspaceId === '') {
    return {
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'missing_workspace_claim',
      closeReason: 'missing workspace claim',
      logDetails: {
        workspaceId,
        role,
        ip,
        reason: 'missing_workspace_claim',
      },
    };
  }

  if (claimedWorkspaceId !== workspaceId) {
    return {
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'workspace_claim_mismatch',
      closeReason: 'workspace claim mismatch',
      logDetails: {
        workspaceId,
        claimedWorkspaceId,
        role,
        ip,
        reason: 'workspace_claim_mismatch',
      },
    };
  }

  const claimedProjectMachineBindingId =
    typeof claims?.projectMachineBindingId === 'string' ? claims.projectMachineBindingId.trim() : '';
  if (requestedProjectMachineBindingId && claimedProjectMachineBindingId !== requestedProjectMachineBindingId) {
    return {
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'project_machine_binding_claim_mismatch',
      closeReason: 'project machine claim mismatch',
      logDetails: {
        workspaceId,
        requestedProjectMachineBindingId,
        claimedProjectMachineBindingId,
        role,
        ip,
        reason: 'project_machine_binding_claim_mismatch',
      },
    };
  }

  const projectMachineBindingId = claimedProjectMachineBindingId || requestedProjectMachineBindingId;
  const machineId = typeof claims?.machineId === 'string' ? claims.machineId.trim() : undefined;
  if (role === 'client' && clientScopeClaim !== 'runtime' && clientScopeClaim !== 'pairing') {
    return {
      ok: false,
      logEvent: 'client_connection_rejected',
      reason: 'invalid_scope_claim',
      closeReason: 'invalid scope claim',
      logDetails: {
        workspaceId,
        ip,
        reason: 'invalid_scope_claim',
        scope: clientScopeClaim,
      },
    };
  }

  if ((role === 'workspace-daemon' || clientScopeClaim === 'runtime') && !projectMachineBindingId) {
    return {
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'missing_project_machine_binding_claim',
      closeReason: 'missing project machine claim',
      sendMissingRuntimeTarget: true,
      logDetails: {
        workspaceId,
        role,
        ip,
        reason: 'missing_project_machine_binding_claim',
      },
    };
  }

  return {
    ok: true,
    clientScopeClaim,
    projectMachineBindingId,
    machineId,
  };
}
