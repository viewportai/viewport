import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const originalProjectConfigDir = process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
const originalLegacyProjectConfigDir = process.env['VPD_PROJECT_CONFIG_DIR'];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viewport-daemon-tests-'));
const unusedProjectOverride = path.join(tempRoot, '.viewport-project-override');
fs.mkdirSync(unusedProjectOverride, { recursive: true });
fs.writeFileSync(path.join(unusedProjectOverride, 'config.json'), '{}\n');

// Keep daemon tests isolated from ambient machine state.
process.env['HOME'] = tempRoot;
process.env['USERPROFILE'] = tempRoot;
delete process.env['VIEWPORT_HOME'];
delete process.env['VPD_HOME'];
process.env['VIEWPORT_PROJECT_CONFIG_DIR'] = unusedProjectOverride;
process.env['VPD_PROJECT_CONFIG_DIR'] = unusedProjectOverride;

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;

  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;

  if (originalProjectConfigDir === undefined) delete process.env['VIEWPORT_PROJECT_CONFIG_DIR'];
  else process.env['VIEWPORT_PROJECT_CONFIG_DIR'] = originalProjectConfigDir;

  if (originalLegacyProjectConfigDir === undefined) delete process.env['VPD_PROJECT_CONFIG_DIR'];
  else process.env['VPD_PROJECT_CONFIG_DIR'] = originalLegacyProjectConfigDir;

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
