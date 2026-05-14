import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeProfileInfo,
  clearCurrentProfile,
  profileHomePath,
  readProfileRegistry,
  resolveProfileAwareViewportHome,
  setCurrentProfile,
  upsertProfileRecord,
  writeProfileRegistry,
} from '../../src/core/profiles.js';

describe('daemon profiles', () => {
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-profiles-'));
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('uses the base home when no profile is active', () => {
    expect(resolveProfileAwareViewportHome({ VIEWPORT_HOME: homeDir })).toBe(homeDir);
    expect(activeProfileInfo({ VIEWPORT_HOME: homeDir })).toMatchObject({
      name: null,
      source: 'none',
      baseHome: homeDir,
      home: homeDir,
    });
  });

  it('uses environment-scoped profiles without changing current profile state', () => {
    expect(resolveProfileAwareViewportHome({ VIEWPORT_HOME: homeDir, VPD_PROFILE: 'prod' })).toBe(
      profileHomePath(homeDir, 'prod'),
    );
    expect(activeProfileInfo({ VIEWPORT_HOME: homeDir, VPD_PROFILE: 'prod' })).toMatchObject({
      name: 'prod',
      source: 'env',
      baseHome: homeDir,
      home: profileHomePath(homeDir, 'prod'),
    });
  });

  it('persists and clears the default current profile', async () => {
    const registry = await readProfileRegistry(homeDir);
    upsertProfileRecord(registry, {
      name: 'local',
      home: profileHomePath(homeDir, 'local'),
    });
    await writeProfileRegistry(registry, homeDir);

    await setCurrentProfile('local', homeDir);
    expect(activeProfileInfo({ VIEWPORT_HOME: homeDir })).toMatchObject({
      name: 'local',
      source: 'current-profile',
      home: profileHomePath(homeDir, 'local'),
    });

    await clearCurrentProfile(homeDir);
    expect(activeProfileInfo({ VIEWPORT_HOME: homeDir })).toMatchObject({
      name: null,
      source: 'none',
      home: homeDir,
    });
  });
});
