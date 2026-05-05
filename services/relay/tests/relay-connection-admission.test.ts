import { describe, expect, it } from 'vitest';
import { resolveConnectionAdmission } from '../src/relay-connection-admission.js';

describe('relay connection admission contracts', () => {
  it('accepts runtime clients scoped to the requested project-machine binding', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        requestedProjectMachineBindingId: 'binding_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_1',
          scope: 'runtime',
          projectMachineBindingId: 'binding_1',
          machineId: 'machine_1',
        },
      }),
    ).toEqual({
      ok: true,
      clientScopeClaim: 'runtime',
      projectMachineBindingId: 'binding_1',
      machineId: 'machine_1',
    });
  });

  it('accepts pairing clients without a project-machine binding', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_1',
          scope: 'pairing',
        },
      }),
    ).toEqual({
      ok: true,
      clientScopeClaim: 'pairing',
      projectMachineBindingId: undefined,
      machineId: undefined,
    });
  });

  it('rejects missing workspace claims', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        ip: '127.0.0.1',
        claims: {
          scope: 'runtime',
        },
      }),
    ).toMatchObject({
      ok: false,
      logEvent: 'connection_rejected',
      reason: 'missing_workspace_claim',
      closeReason: 'missing workspace claim',
    });
  });

  it('rejects workspace claim mismatches', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_2',
          scope: 'runtime',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'workspace_claim_mismatch',
      closeReason: 'workspace claim mismatch',
    });
  });

  it('rejects project-machine binding claim mismatches', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        requestedProjectMachineBindingId: 'binding_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_1',
          scope: 'runtime',
          projectMachineBindingId: 'binding_2',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'project_machine_binding_claim_mismatch',
      closeReason: 'project machine claim mismatch',
    });
  });

  it('rejects runtime clients without a project-machine binding target', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_1',
          scope: 'runtime',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'missing_project_machine_binding_claim',
      closeReason: 'missing project machine claim',
      sendMissingRuntimeTarget: true,
    });
  });

  it('rejects daemons without a project-machine binding target', () => {
    expect(
      resolveConnectionAdmission({
        role: 'workspace-daemon',
        workspaceId: 'workspace_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_1',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'missing_project_machine_binding_claim',
      closeReason: 'missing project machine claim',
      sendMissingRuntimeTarget: true,
    });
  });

  it('rejects client connections without a valid runtime or pairing scope', () => {
    expect(
      resolveConnectionAdmission({
        role: 'client',
        workspaceId: 'workspace_1',
        ip: '127.0.0.1',
        claims: {
          workspaceId: 'workspace_1',
        },
      }),
    ).toMatchObject({
      ok: false,
      logEvent: 'client_connection_rejected',
      reason: 'invalid_scope_claim',
      closeReason: 'invalid scope claim',
    });
  });
});
