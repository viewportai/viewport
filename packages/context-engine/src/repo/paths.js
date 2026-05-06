const path = require('node:path');

function vaultPaths(home) {
  return {
    home,
    identitiesDir: path.join(home, 'identities'),
    reposDir: path.join(home, 'repos'),
  };
}

function repoPaths(home, repoId) {
  const root = path.join(home, 'repos', repoId);

  return {
    root,
    metadata: path.join(root, 'metadata.json'),
    eventsDir: path.join(root, 'events'),
    eraseReceiptsDir: path.join(root, 'erase-receipts'),
    profilesDir: path.join(root, 'profiles'),
    keys: path.join(root, 'keys.json'),
    db: path.join(root, 'materialized.sqlite'),
  };
}

module.exports = { repoPaths, vaultPaths };
