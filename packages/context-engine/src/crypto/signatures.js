const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');

function signEnvelope(unsignedEnvelope, identity) {
  return crypto.sign(
    null,
    Buffer.from(canonicalize(unsignedEnvelope)),
    identity.signingPrivateKey ?? identity.privateKey,
  ).toString('base64');
}

function verifyEnvelope(envelope, publicKey) {
  const { signature, ...unsignedEnvelope } = envelope;

  return crypto.verify(
    null,
    Buffer.from(canonicalize(unsignedEnvelope)),
    publicKey,
    Buffer.from(signature, 'base64'),
  );
}

module.exports = { signEnvelope, verifyEnvelope };
