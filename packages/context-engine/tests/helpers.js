const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ContextVault } = require('../src');

function tempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function readAllText(dir) {
  let output = '';
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      output += readAllText(full);
      continue;
    }
    output += fs.readFileSync(full, 'utf8');
  }
  return output;
}

function pairedVaults() {
  const aliceVault = new ContextVault(tempHome('vault-alice'));
  const bobVault = new ContextVault(tempHome('vault-bob'));

  aliceVault.createIdentity('alice');
  bobVault.createIdentity('bob');
  aliceVault.importPublicIdentity(bobVault.exportPublicIdentity('bob'));
  bobVault.importPublicIdentity(aliceVault.exportPublicIdentity('alice'));

  aliceVault.createRepo('project-api', 'alice');

  return { aliceVault, bobVault };
}

module.exports = { pairedVaults, readAllText, tempHome };
