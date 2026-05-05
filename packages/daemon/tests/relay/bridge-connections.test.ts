import { describe, expect, it } from 'vitest';
import { daemonAuthHeaders, relayDaemonUrl } from '../../src/relay/bridge-connections.js';

describe('bridge connection contracts', () => {
  it('omits daemon auth headers when local auth is disabled', () => {
    expect(daemonAuthHeaders(undefined)).toBeUndefined();
    expect(daemonAuthHeaders('')).toBeUndefined();
  });

  it('builds daemon auth headers when local auth is enabled', () => {
    expect(daemonAuthHeaders('local-token')).toEqual({
      authorization: 'Bearer local-token',
    });
  });

  it('builds relay daemon url without project-machine scope', () => {
    expect(
      relayDaemonUrl({
        relayEndpoint: 'wss://relay.test/ws',
        workspaceId: 'workspace one',
      }),
    ).toBe('wss://relay.test/ws?role=workspace-daemon&workspaceId=workspace%20one');
  });

  it('builds relay daemon url with encoded project-machine scope', () => {
    expect(
      relayDaemonUrl({
        relayEndpoint: 'wss://relay.test/ws',
        workspaceId: 'workspace one',
        projectMachineBindingId: 'machine/binding:one',
      }),
    ).toBe(
      'wss://relay.test/ws?role=workspace-daemon&workspaceId=workspace%20one&projectMachineBindingId=machine%2Fbinding%3Aone',
    );
  });
});
