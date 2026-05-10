#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function canonicalJson(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  }

  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function readVector(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function decodeHpkeGrant(vector) {
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });

  const { grant, recipient } = vector;
  const privateKey = await suite.kem.deserializePrivateKey(Buffer.from(recipient.hpkePrivateKey, 'base64'));
  const info = Buffer.from(canonicalJson({
    purpose: 'viewport-context-repo-key-grant',
    version: grant.version,
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
    suite: grant.suite,
  }));
  const aad = Buffer.from(canonicalJson({
    version: grant.version,
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
  }));
  const aadDigest = `sha256:${sha256Hex(aad)}`;

  assert.equal(grant.aadDigest, aadDigest);

  const recipientContext = await suite.createRecipientContext({
    recipientKey: privateKey,
    enc: Buffer.from(grant.enc, 'base64'),
    info,
  });
  const repoKey = Buffer.from(await recipientContext.open(Buffer.from(grant.ciphertext, 'base64'), aad));
  const repoKeyDigest = `sha256:${sha256Hex(repoKey)}`;

  assert.equal(repoKeyDigest, vector.expectedRepoKeyDigest);

  return {
    vector: 'hpke-key-grant.json',
    ok: true,
    aad_digest: aadDigest,
    repo_key_digest: repoKeyDigest,
  };
}

function verifySignedEvent(vector) {
  const { signature, ...unsignedEvent } = vector.event;
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalJson(unsignedEvent)),
    vector.actor.signingPublicKey,
    Buffer.from(signature, 'base64'),
  );

  assert.equal(verified, true);

  const tamperedEvent = {
    ...unsignedEvent,
    payloadDigest: `sha256:${'0'.repeat(64)}`,
  };
  const tamperedVerified = crypto.verify(
    null,
    Buffer.from(canonicalJson(tamperedEvent)),
    vector.actor.signingPublicKey,
    Buffer.from(signature, 'base64'),
  );

  assert.equal(tamperedVerified, false);

  return {
    vector: 'signed-event.json',
    ok: true,
    tamper_rejected: true,
  };
}

const result = {
  schemaVersion: 'viewport.context_protocol_standalone_decoder_result/v1',
  hpke_key_grant: await decodeHpkeGrant(readVector('hpke-key-grant.json')),
  signed_event: verifySignedEvent(readVector('signed-event.json')),
};

console.log(JSON.stringify(result, null, 2));
