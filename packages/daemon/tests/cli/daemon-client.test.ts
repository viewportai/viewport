import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDaemonEndpoint } from '../../src/cli/daemon-client.js';
import {
  clearDaemonRuntimeState,
  writeDaemonRuntimeState,
} from '../../src/cli/daemon-lifecycle.js';

describe('daemon client endpoint resolution', () => {
  let tempHome: string;
  let originalViewportHome: string | undefined;
  let originalTls: string | undefined;
  let originalTlsHost: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-daemon-client-'));
    originalViewportHome = process.env['VIEWPORT_HOME'];
    originalTls = process.env['VIEWPORT_TLS'];
    originalTlsHost = process.env['VIEWPORT_TLS_HOST'];
    process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');
  });

  afterEach(async () => {
    await clearDaemonRuntimeState();
    if (originalViewportHome === undefined) delete process.env['VIEWPORT_HOME'];
    else process.env['VIEWPORT_HOME'] = originalViewportHome;
    if (originalTls === undefined) delete process.env['VIEWPORT_TLS'];
    else process.env['VIEWPORT_TLS'] = originalTls;
    if (originalTlsHost === undefined) delete process.env['VIEWPORT_TLS_HOST'];
    else process.env['VIEWPORT_TLS_HOST'] = originalTlsHost;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('prefers persisted tls state over the current shell environment', async () => {
    process.env['VIEWPORT_TLS'] = '0';
    await writeDaemonRuntimeState({
      ownerPid: 4321,
      port: 7443,
      host: '127.0.0.1',
      startedAt: Date.now(),
      version: '0.2.0',
      mode: 'supervisor',
      tlsEnabled: true,
      tlsHost: 'daemon.example.test',
    });

    const endpoint = await resolveDaemonEndpoint();
    expect(endpoint.type).toBe('tcp');
    if (endpoint.type === 'tcp') {
      expect(endpoint.baseUrl).toBe('https://daemon.example.test:7443');
      expect(endpoint.wsUrl).toBe('wss://daemon.example.test:7443/ws');
    }
  });

  it('keeps plain http endpoints when the persisted runtime says tls is off', async () => {
    process.env['VIEWPORT_TLS'] = '1';
    process.env['VIEWPORT_TLS_HOST'] = 'getviewport.test';
    await writeDaemonRuntimeState({
      ownerPid: 4321,
      port: 7070,
      host: '127.0.0.1',
      startedAt: Date.now(),
      version: '0.2.0',
      mode: 'supervisor',
      tlsEnabled: false,
    });

    const endpoint = await resolveDaemonEndpoint();
    expect(endpoint.type).toBe('tcp');
    if (endpoint.type === 'tcp') {
      expect(endpoint.baseUrl).toBe('http://127.0.0.1:7070');
      expect(endpoint.wsUrl).toBe('ws://127.0.0.1:7070/ws');
    }
  });
});
