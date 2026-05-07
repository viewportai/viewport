const path = require('node:path');
const { canonicalize } = require('../crypto/canonical');
const { digest } = require('../crypto/envelope');
const { writeJson, readJson } = require('./files');
const { repoPaths } = require('./paths');

class ContextProfilePinMismatchError extends Error {
  constructor(mismatches) {
    super(`Context profile pin mismatch: ${mismatches.map(({ field }) => field).join(', ')}`);
    this.name = 'ContextProfilePinMismatchError';
    this.code = 'CONTEXT_PROFILE_PIN_MISMATCH';
    this.mismatches = mismatches;
  }
}

function profilePath(name) {
  return `.viewport/context/profiles/${name}.json`;
}

function writeProfile(home, { repoId, name, profile }) {
  const paths = repoPaths(home, repoId);
  const descriptor = {
    schemaVersion: 'viewport.context_profile/v1',
    name,
    path: profilePath(name),
    profile,
    digest: digest(canonicalize(profile)),
    updatedAt: new Date().toISOString(),
  };
  writeJson(path.join(paths.profilesDir, `${name}.json`), descriptor);
  return descriptor;
}

function getProfile(home, { repoId, name, expected = null }) {
  const descriptor = readJson(path.join(repoPaths(home, repoId).profilesDir, `${name}.json`));
  if (!descriptor) {
    throw new Error(`Unknown context profile: ${name}`);
  }

  const mismatches = [];
  if (expected?.path && expected.path !== descriptor.path) {
    mismatches.push({ field: 'path', expected: expected.path, actual: descriptor.path });
  }
  if (expected?.digest && expected.digest !== descriptor.digest) {
    mismatches.push({ field: 'digest', expected: expected.digest, actual: descriptor.digest });
  }
  if (mismatches.length > 0) {
    throw new ContextProfilePinMismatchError(mismatches);
  }

  return descriptor;
}

module.exports = { ContextProfilePinMismatchError, getProfile, writeProfile };
