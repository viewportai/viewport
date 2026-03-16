import { describe, expect, it } from 'vitest';
import { classifyUpdateCheckFailure } from '../../src/cli/runtime-toolchain.js';

describe('runtime toolchain update-check classification', () => {
  const packageName = '@viewportai/daemon';

  it('classifies unpublished package lookup as unavailable', () => {
    const note = classifyUpdateCheckFailure({
      packageName,
      exitCode: 1,
      stderr:
        "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@viewportai%2fdaemon - Not found\nnpm ERR! 404 '@viewportai/daemon@*' is not in this registry.",
    });
    expect(note).toBe('update check unavailable: package not published yet');
  });

  it('classifies auth issues as unavailable', () => {
    const note = classifyUpdateCheckFailure({
      packageName,
      exitCode: 1,
      stderr:
        'npm notice Access token expired or revoked. Please try logging in again.\nnpm ERR! code E401',
    });
    expect(note).toBe('update check unavailable: npm auth issue');
  });

  it('classifies network issues as unavailable', () => {
    const note = classifyUpdateCheckFailure({
      packageName,
      exitCode: 1,
      stderr: 'npm ERR! code ENOTFOUND\nnpm ERR! request to registry.npmjs.org failed',
    });
    expect(note).toBe('update check unavailable: network issue');
  });

  it('falls back to compact first-line error for unknown failures', () => {
    const note = classifyUpdateCheckFailure({
      packageName,
      exitCode: 2,
      stderr: 'npm ERR! code EUNKNOWN\nnpm ERR! something unexpected happened',
    });
    expect(note).toBe('update check failed: code EUNKNOWN');
  });
});
