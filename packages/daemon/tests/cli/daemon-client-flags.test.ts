import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('daemon client explicit endpoint flags', () => {
  let tempHome: string;
  let originalViewportHome: string | undefined;
  let originalArgv: string[];

  beforeEach(async () => {
    vi.resetModules();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-daemon-client-flags-'));
    originalViewportHome = process.env['VIEWPORT_HOME'];
    originalArgv = process.argv;
    process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalViewportHome === undefined) delete process.env['VIEWPORT_HOME'];
    else process.env['VIEWPORT_HOME'] = originalViewportHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('does not let stale runtime state mask an explicit listen target', async () => {
    process.argv = ['node', 'vpd', 'hook', 'notify', '--listen', '127.0.0.1:19990'];

    const { writeDaemonRuntimeState } = await import('../../src/cli/daemon-lifecycle.js');
    await writeDaemonRuntimeState({
      ownerPid: 4321,
      port: 7070,
      host: '127.0.0.1',
      startedAt: Date.now(),
      version: '0.2.0',
      mode: 'supervisor',
      tlsEnabled: false,
    });

    const { resolveDaemonEndpoint } = await import('../../src/cli/daemon-client.js');
    const endpoint = await resolveDaemonEndpoint();

    expect(endpoint.type).toBe('tcp');
    if (endpoint.type === 'tcp') {
      expect(endpoint.baseUrl).toBe('http://127.0.0.1:19990');
      expect(endpoint.port).toBe(19990);
    }
  });
});
