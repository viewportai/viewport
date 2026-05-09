import { describe, expect, it } from 'vitest';
import {
  missingRuntimeTargetPayload,
  relayRedirectPayload,
  relayStatusPayload,
  runtimeScopeKey,
} from '../src/relay-status-payloads.js';

describe('relay status payload contracts', () => {
  it('scopes runtime connections by workspace when no machine target is present', () => {
    expect(runtimeScopeKey('workspace_1')).toBe('workspace_1');
  });

  it('scopes runtime connections by workspace and runtime target', () => {
    expect(runtimeScopeKey('workspace_1', 'binding_1')).toBe('workspace_1:binding_1');
  });

  it('reports unavailable runtime with retryable machine-scoped metadata', () => {
    expect(relayStatusPayload('workspace_1', 'binding_1', 'machine_1')).toEqual({
      type: 'relay_status',
      code: 'DAEMON_UNAVAILABLE',
      message: 'No machine runtime is connected for this runtime target',
      workspaceId: 'workspace_1',
      runtimeTargetId: 'binding_1',
      machineId: 'machine_1',
      retryable: true,
    });
  });

  it('reports missing runtime target as non-retryable', () => {
    expect(missingRuntimeTargetPayload('workspace_1')).toEqual({
      type: 'relay_status',
      code: 'RUNTIME_TARGET_REQUIRED',
      message: 'Runtime client must specify a runtime target',
      workspaceId: 'workspace_1',
      retryable: false,
    });
  });

  it('reports relay redirect with the assigned websocket base URL', () => {
    expect(relayRedirectPayload('workspace_1', 'wss://relay.example/ws', 'binding_1')).toEqual({
      type: 'relay_status',
      code: 'RELAY_REDIRECT',
      message: 'Workspace is assigned to a different relay instance',
      workspaceId: 'workspace_1',
      runtimeTargetId: 'binding_1',
      relayWsBaseUrl: 'wss://relay.example/ws',
    });
  });
});
