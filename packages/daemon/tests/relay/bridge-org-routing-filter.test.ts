import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrgRoutingFilter } from '../../src/relay/bridge-org-routing-filter.js';

describe('relay bridge organization routing filter', () => {
  let allowedDir = '';
  let blockedDir = '';

  beforeEach(async () => {
    allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-allowed-'));
    blockedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-blocked-'));
    await fs.mkdir(path.join(allowedDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(allowedDir, '.viewport/local.yaml'),
      'version: 1\norganization_id: 01ORG\nremote:\n  stream: enabled\n',
    );
  });

  afterEach(async () => {
    await fs.rm(allowedDir, { recursive: true, force: true });
    await fs.rm(blockedDir, { recursive: true, force: true });
  });

  it('filters hello payloads down to directories bound to the active organization', () => {
    const filter = createOrgRoutingFilter({ organizationId: '01ORG' });
    const payload = filter.filter(
      JSON.stringify({
        type: 'hello',
        directories: [
          { id: 'allowed', path: allowedDir },
          { id: 'blocked', path: blockedDir },
        ],
        activeSessions: [
          { id: 'session_allowed', directoryId: 'allowed', workingDirectory: allowedDir },
          { id: 'session_blocked', directoryId: 'blocked', workingDirectory: blockedDir },
        ],
        discoveredSessions: [],
      }),
    );

    expect(payload).toBeTruthy();
    const parsed = JSON.parse(payload ?? '{}') as {
      directories: Array<{ id: string }>;
      activeSessions: Array<{ id: string }>;
    };
    expect(parsed.directories.map((entry) => entry.id)).toEqual(['allowed']);
    expect(parsed.activeSessions.map((entry) => entry.id)).toEqual(['session_allowed']);
  });

  it('drops session updates for unbound or unknown sessions', () => {
    const filter = createOrgRoutingFilter({ organizationId: '01ORG' });
    filter.filter(
      JSON.stringify({
        type: 'hello',
        directories: [{ id: 'allowed', path: allowedDir }],
        activeSessions: [{ id: 'session_allowed', directoryId: 'allowed' }],
        discoveredSessions: [],
      }),
    );

    expect(
      filter.filter(
        JSON.stringify({
          type: 'session-update',
          sessionId: 'session_allowed',
          update: { updateType: 'state-change' },
        }),
      ),
    ).toBeTruthy();
    expect(
      filter.filter(
        JSON.stringify({
          type: 'session-update',
          sessionId: 'session_unknown',
          update: { updateType: 'state-change' },
        }),
      ),
    ).toBeNull();
  });
});
