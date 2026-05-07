const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
  HPKE_KEY_GRANT_VERSION,
  HPKE_SUITE,
  createHpkeIdentity,
  unwrapRepoKeyWithHpke,
  wrapRepoKeyWithHpke,
} = require('../src/crypto/hpke-grants');

function mutateBase64(value) {
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
}

test('HPKE grant wraps repo key for intended recipient', async () => {
  const bob = await createHpkeIdentity('bob');
  const repoKey = crypto.randomBytes(32);
  const grant = await wrapRepoKeyWithHpke(repoKey, bob, {
    repoId: 'project-api',
    keyEpoch: 3,
  });

  assert.equal(grant.version, HPKE_KEY_GRANT_VERSION);
  assert.deepEqual(grant.suite, HPKE_SUITE);
  assert.equal(grant.recipientName, 'bob');
  assert.equal(grant.repoId, 'project-api');
  assert.equal(grant.keyEpoch, 3);
  assert.match(grant.aadDigest, /^sha256:[a-f0-9]{64}$/);

  const recovered = await unwrapRepoKeyWithHpke(grant, bob);
  assert.equal(recovered.equals(repoKey), true);
});

test('HPKE grant rejects non repo-key-sized plaintext', async () => {
  const bob = await createHpkeIdentity('bob');

  await assert.rejects(
    () => wrapRepoKeyWithHpke(Buffer.alloc(16, 1), bob),
    /32-byte repo key/,
  );
});

test('HPKE grant rejects wrong recipient and tampered ciphertext', async () => {
  const bob = await createHpkeIdentity('bob');
  const carol = await createHpkeIdentity('carol');
  const repoKey = crypto.randomBytes(32);
  const grant = await wrapRepoKeyWithHpke(repoKey, bob);

  await assert.rejects(
    () => unwrapRepoKeyWithHpke(grant, carol),
    /belongs to bob/,
  );

  const tampered = structuredClone(grant);
  tampered.ciphertext = mutateBase64(tampered.ciphertext);
  await assert.rejects(() => unwrapRepoKeyWithHpke(tampered, bob));
});

test('HPKE grant rejects tampered suite and AAD metadata before plaintext recovery', async () => {
  const bob = await createHpkeIdentity('bob');
  const repoKey = crypto.randomBytes(32);
  const grant = await wrapRepoKeyWithHpke(repoKey, bob, {
    repoId: 'project-api',
    keyEpoch: 3,
  });

  const suiteTampered = structuredClone(grant);
  suiteTampered.suite.aead = 'AES_128_GCM';
  await assert.rejects(
    () => unwrapRepoKeyWithHpke(suiteTampered, bob),
    /Unsupported HPKE suite/,
  );

  const aadTampered = structuredClone(grant);
  aadTampered.aadDigest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    () => unwrapRepoKeyWithHpke(aadTampered, bob),
    /AAD digest mismatch/,
  );
});

test('HPKE grant rejects stale epoch or wrong repo binding when caller expects a specific grant', async () => {
  const bob = await createHpkeIdentity('bob');
  const repoKey = crypto.randomBytes(32);
  const grant = await wrapRepoKeyWithHpke(repoKey, bob, {
    repoId: 'project-api',
    keyEpoch: 8,
  });

  await assert.rejects(
    () => unwrapRepoKeyWithHpke(grant, bob, { expectedKeyEpoch: 7 }),
    /epoch 8, not 7/,
  );
  await assert.rejects(
    () => unwrapRepoKeyWithHpke(grant, bob, { expectedRepoId: 'project-web' }),
    /repo project-api, not project-web/,
  );
});

test('HPKE grant can be decoded from documented fields without helper code', async () => {
  const { Aes256Gcm, CipherSuite, HkdfSha256 } = await import('@hpke/core');
  const { DhkemX25519HkdfSha256 } = await import('@hpke/dhkem-x25519');
  const bob = await createHpkeIdentity('bob');
  const repoKey = crypto.randomBytes(32);
  const grant = await wrapRepoKeyWithHpke(repoKey, bob, {
    repoId: 'project-independent',
    keyEpoch: 9,
  });
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  const stableJson = (value) => {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJson(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }

    return JSON.stringify(value);
  };
  const privateKey = await suite.kem.deserializePrivateKey(Buffer.from(bob.hpkePrivateKey, 'base64'));
  const recipient = await suite.createRecipientContext({
    recipientKey: privateKey,
    enc: Buffer.from(grant.enc, 'base64'),
    info: Buffer.from(stableJson({
      purpose: 'viewport-context-repo-key-grant',
      version: grant.version,
      recipientName: grant.recipientName,
      repoId: grant.repoId,
      keyEpoch: grant.keyEpoch,
      suite: grant.suite,
    }), 'utf8'),
  });
  const aad = Buffer.from(stableJson({
    version: grant.version,
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
  }), 'utf8');
  const recovered = Buffer.from(await recipient.open(Buffer.from(grant.ciphertext, 'base64'), aad));

  assert.equal(recovered.equals(repoKey), true);
});
