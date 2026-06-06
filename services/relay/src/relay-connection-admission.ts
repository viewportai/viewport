import type { AdmissionClaims, RelayRole } from './types.js';

export interface RelayConnectionAdmissionInput {
  role: RelayRole;
  workspaceId: string;
  requestedRuntimeTargetId?: string;
  ip: string;
  claims?: AdmissionClaims;
}

export type RelayConnectionAdmissionResult =
  | {
      ok: true;
      clientScopeClaim?: AdmissionClaims['scope'];
      runtimeTargetId?: string;
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
  const { role, workspaceId, requestedRuntimeTargetId, ip, claims } = input;
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

  const claimedRuntimeTargetId =
    typeof claims?.runtimeTargetId === 'string' ? claims.runtimeTargetId.trim() : '';
  if (requestedRuntimeTargetId && claimedRuntimeTargetId !== requestedRuntimeTargetId) {
    return {
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'runtime_target_claim_mismatch',
      closeReason: 'runtime target claim mismatch',
      logDetails: {
        workspaceId,
        requestedRuntimeTargetId,
        claimedRuntimeTargetId,
        role,
        ip,
        reason: 'runtime_target_claim_mismatch',
      },
    };
  }

  const runtimeTargetId = claimedRuntimeTargetId || requestedRuntimeTargetId;
  const machineId = typeof claims?.machineId === 'string' ? claims.machineId.trim() : undefined;
  if (
    role === 'client' &&
    clientScopeClaim !== 'runtime' &&
    clientScopeClaim !== 'pairing' &&
    clientScopeClaim !== 'session-events'
  ) {
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

  if (
    (role === 'workspace-daemon' ||
      (role === 'client' && (clientScopeClaim === 'runtime' || clientScopeClaim === 'session-events'))) &&
    !runtimeTargetId
  ) {
    return {
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'missing_runtime_target_claim',
      closeReason: 'missing runtime target claim',
      sendMissingRuntimeTarget: true,
      logDetails: {
        workspaceId,
        role,
        ip,
        reason: 'missing_runtime_target_claim',
      },
    };
  }

  return {
    ok: true,
    clientScopeClaim,
    runtimeTargetId,
    machineId,
  };
}
