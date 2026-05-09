import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const originalResourceOverrideDir = process.env['VIEWPORT_RESOURCE_OVERRIDE_DIR'];
const originalLegacyProjectConfigDir = process.env['VPD_RESOURCE_OVERRIDE_DIR'];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viewport-daemon-tests-'));
const unusedResourceOverride = path.join(tempRoot, '.viewport-resource-override');
fs.mkdirSync(unusedResourceOverride, { recursive: true });
fs.writeFileSync(path.join(unusedResourceOverride, 'config.json'), '{}\n');

// Keep daemon tests isolated from ambient machine state.
process.env['HOME'] = tempRoot;
process.env['USERPROFILE'] = tempRoot;
delete process.env['VIEWPORT_HOME'];
delete process.env['VPD_HOME'];
process.env['VIEWPORT_RESOURCE_OVERRIDE_DIR'] = unusedResourceOverride;
process.env['VPD_RESOURCE_OVERRIDE_DIR'] = unusedResourceOverride;

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;

  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;

  if (originalResourceOverrideDir === undefined)
    delete process.env['VIEWPORT_RESOURCE_OVERRIDE_DIR'];
  else process.env['VIEWPORT_RESOURCE_OVERRIDE_DIR'] = originalResourceOverrideDir;

  if (originalLegacyProjectConfigDir === undefined) delete process.env['VPD_RESOURCE_OVERRIDE_DIR'];
  else process.env['VPD_RESOURCE_OVERRIDE_DIR'] = originalLegacyProjectConfigDir;

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
