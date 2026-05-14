const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ContextVault } = require('../src');
const { tempHome } = require('./helpers');

test('public identity import refuses silent key replacement', () => {
  const aliceVault = new ContextVault(tempHome('vault-identity-alice'));
  const bobVault = new ContextVault(tempHome('vault-identity-bob'));
  const attackerVault = new ContextVault(tempHome('vault-identity-attacker'));

  aliceVault.createIdentity('alice');
  bobVault.createIdentity('bob');
  attackerVault.createIdentity('bob');

  aliceVault.importPublicIdentity(bobVault.exportPublicIdentity('bob'));

  assert.throws(
    () => aliceVault.importPublicIdentity(attackerVault.exportPublicIdentity('bob')),
    /Identity signing key changed/,
  );
});

test('public identity import accepts equivalent PEM keys with different trailing newlines', () => {
  const aliceVault = new ContextVault(tempHome('vault-identity-newline-alice'));
  const bobVault = new ContextVault(tempHome('vault-identity-newline-bob'));

  aliceVault.createIdentity('alice');
  bobVault.createIdentity('bob');

  const identity = bobVault.exportPublicIdentity('bob');
  aliceVault.importPublicIdentity(identity);

  aliceVault.importPublicIdentity({
    ...identity,
    publicKey: identity.publicKey.trimEnd(),
    signingPublicKey: identity.signingPublicKey.trimEnd(),
    encryptionPublicKey: identity.encryptionPublicKey.trimEnd(),
  });
});
