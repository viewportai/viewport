import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrgRoutingFilter } from '../../src/relay/bridge-org-routing-filter.js';

describe('relay bridge organization routing filter', () => {
  let allowedDir = '';
  let blockedDir = '';
  let hintOnlyDir = '';
  let disabledDir = '';

  beforeEach(async () => {
    allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-allowed-'));
    blockedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-blocked-'));
    hintOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-hint-only-'));
    disabledDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-disabled-'));
    await fs.mkdir(path.join(allowedDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(allowedDir, '.viewport/local.yaml'),
      'version: 1\norganization_id: 01ORG\nremote:\n  stream: enabled\n',
    );
    await fs.mkdir(path.join(hintOnlyDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(hintOnlyDir, '.viewport/workspace.yaml'),
      'version: 1\norganization_id: 01ORG\n',
    );
    await fs.mkdir(path.join(disabledDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(disabledDir, '.viewport/local.yaml'),
      'version: 1\norganization_id: 01ORG\nremote:\n  stream: disabled\n',
    );
  });

  afterEach(async () => {
    await fs.rm(allowedDir, { recursive: true, force: true });
    await fs.rm(blockedDir, { recursive: true, force: true });
    await fs.rm(hintOnlyDir, { recursive: true, force: true });
    await fs.rm(disabledDir, { recursive: true, force: true });
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

  it('does not stream from a committed workspace hint without a local binding grant', () => {
    const filter = createOrgRoutingFilter({ organizationId: '01ORG' });
    const payload = filter.filter(
      JSON.stringify({
        type: 'hello',
        directories: [{ id: 'hint-only', path: hintOnlyDir }],
        activeSessions: [
          { id: 'session_hint_only', directoryId: 'hint-only', workingDirectory: hintOnlyDir },
        ],
        discoveredSessions: [],
      }),
    );

    expect(payload).toBeTruthy();
    const parsed = JSON.parse(payload ?? '{}') as {
      directories: Array<{ id: string }>;
      activeSessions: Array<{ id: string }>;
    };
    expect(parsed.directories).toEqual([]);
    expect(parsed.activeSessions).toEqual([]);
  });

  it('drops directories whose local binding targets another organization or disables streaming', async () => {
    const otherOrgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-filter-other-org-'));
    await fs.mkdir(path.join(otherOrgDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(otherOrgDir, '.viewport/local.yaml'),
      'version: 1\norganization_id: 01OTHER\nremote:\n  stream: enabled\n',
    );

    try {
      const filter = createOrgRoutingFilter({ organizationId: '01ORG' });
      const payload = filter.filter(
        JSON.stringify({
          type: 'hello',
          directories: [
            { id: 'other-org', path: otherOrgDir },
            { id: 'disabled', path: disabledDir },
          ],
          activeSessions: [
            { id: 'session_other_org', directoryId: 'other-org', workingDirectory: otherOrgDir },
            { id: 'session_disabled', directoryId: 'disabled', workingDirectory: disabledDir },
          ],
          discoveredSessions: [],
        }),
      );

      expect(payload).toBeTruthy();
      const parsed = JSON.parse(payload ?? '{}') as {
        directories: Array<{ id: string }>;
        activeSessions: Array<{ id: string }>;
      };
      expect(parsed.directories).toEqual([]);
      expect(parsed.activeSessions).toEqual([]);
    } finally {
      await fs.rm(otherOrgDir, { recursive: true, force: true });
    }
  });

  it('cuts a pinned session if its directory binding changes away from the relay organization', async () => {
    const filter = createOrgRoutingFilter({ organizationId: '01ORG' });
    filter.filter(
      JSON.stringify({
        type: 'hello',
        directories: [{ id: 'allowed', path: allowedDir }],
        activeSessions: [
          { id: 'session_allowed', directoryId: 'allowed', workingDirectory: allowedDir },
        ],
        discoveredSessions: [],
      }),
    );

    await fs.writeFile(
      path.join(allowedDir, '.viewport/local.yaml'),
      'version: 1\norganization_id: 01OTHER\nremote:\n  stream: enabled\n',
    );

    expect(
      filter.filter(
        JSON.stringify({
          type: 'session-update',
          sessionId: 'session_allowed',
          update: { updateType: 'state-change' },
        }),
      ),
    ).toBeNull();
  });
});
