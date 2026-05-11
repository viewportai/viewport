import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('daemon relay identity store', () => {
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-relay-identity-'));
    process.env['VIEWPORT_HOME'] = homeDir;
  });

  afterEach(async () => {
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('creates separate key material per organization binding', async () => {
    const { loadOrCreateIdentity } = await import('../../src/relay/bridge-identity-store.js');

    const orgA = await loadOrCreateIdentity('01ORG_A');
    const orgB = await loadOrCreateIdentity('01ORG_B');
    const orgAAgain = await loadOrCreateIdentity('01ORG_A');

    expect(orgA.deviceId).toBe(orgAAgain.deviceId);
    expect(orgA.publicKey).toBe(orgAAgain.publicKey);
    expect(orgA.deviceId).not.toBe(orgB.deviceId);
    expect(orgA.publicKey).not.toBe(orgB.publicKey);

    await expect(
      fs.readFile(path.join(homeDir, 'relay-identities', '01ORG_A.json'), 'utf8'),
    ).resolves.toContain(orgA.publicKey);
    await expect(
      fs.readFile(path.join(homeDir, 'relay-identities', '01ORG_B.json'), 'utf8'),
    ).resolves.toContain(orgB.publicKey);
  });
});
