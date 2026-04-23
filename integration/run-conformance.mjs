import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_DIR = path.join(ROOT, 'packages', 'daemon');
const VECTORS_PATH = path.join(DAEMON_DIR, 'docs', 'relay-noise-v3-conformance-vectors.json');

function fromBase64Url(input) {
  return Buffer.from(input, 'base64url');
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function buildDaemon() {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: DAEMON_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`daemon build failed with code ${result.status}`);
  }
}

async function loadNoiseModule() {
  const modulePath = pathToFileURL(path.join(DAEMON_DIR, 'dist', 'relay', 'bridge-noise-v3.js')).href;
  const cryptoPath = pathToFileURL(path.join(DAEMON_DIR, 'dist', 'relay', 'bridge-crypto.js')).href;
  const noise = await import(modulePath);
  const bridgeCrypto = await import(cryptoPath);
  return {
    ...noise,
    ...bridgeCrypto,
  };
}

async function main() {
  buildDaemon();
  const {
    createNoiseV3Init,
    deriveNoiseV3SessionFromInit,
    finalizeNoiseV3Response,
    toBase64Url: daemonToBase64,
  } = await loadNoiseModule();

  const parsed = JSON.parse(await fs.readFile(VECTORS_PATH, 'utf8'));
  const vectors = Array.isArray(parsed?.vectors) ? parsed.vectors : [];
  if (vectors.length === 0) {
    throw new Error('No v3 conformance vectors found');
  }

  const daemonIdentity = {
    algorithm: 'p256',
    publicKey: parsed.daemonIdentity.publicKey,
    privateKey: parsed.daemonIdentity.privateKey,
  };

  const deterministicStaticPrivate = fromBase64Url(parsed.clientDeterministicKeys.staticPrivateKey);
  const deterministicEphemeralPrivate = fromBase64Url(parsed.clientDeterministicKeys.ephemeralPrivateKey);
  const deterministicDaemonEphemeral = fromBase64Url(parsed.daemonDeterministicEphemeralPrivateKey);

  for (const vector of vectors) {
    const pairingSecret =
      typeof vector.pairingSecret === 'string' ? fromBase64Url(vector.pairingSecret) : undefined;

    const init = createNoiseV3Init({
      profile: vector.profile,
      requestId: vector.requestId,
      daemonPublicKey: daemonIdentity.publicKey,
      pairingSecret,
      clientStaticPrivateKeyOverride: deterministicStaticPrivate,
      clientEphemeralPrivateKeyOverride: deterministicEphemeralPrivate,
    });

    if (init.frame.clientEphemeralPublicKey !== vector.init.clientEphemeralPublicKey) {
      throw new Error(`${vector.id}: clientEphemeralPublicKey mismatch`);
    }
    if (init.frame.encryptedClientStatic !== vector.init.encryptedClientStatic) {
      throw new Error(`${vector.id}: encryptedClientStatic mismatch`);
    }

    const derived = deriveNoiseV3SessionFromInit({
      init: init.frame,
      daemonIdentity,
      nextEpoch: vector.epoch,
      pairingSecret,
      daemonEphemeralPrivateKeyOverride: deterministicDaemonEphemeral,
      sessionIdOverride: vector.sessionId,
    });

    if (derived.response.daemonEphemeralPublicKey !== vector.response.daemonEphemeralPublicKey) {
      throw new Error(`${vector.id}: daemonEphemeralPublicKey mismatch`);
    }
    if (derived.response.encryptedMetadata !== vector.response.encryptedMetadata) {
      throw new Error(`${vector.id}: encryptedMetadata mismatch`);
    }
    if (derived.response.proof !== vector.response.proof) {
      throw new Error(`${vector.id}: proof mismatch`);
    }

    const sessionKey = daemonToBase64(derived.session.key);
    if (sessionKey !== vector.sessionKey) {
      throw new Error(`${vector.id}: sessionKey mismatch`);
    }

    const finalized = finalizeNoiseV3Response({
      state: init.state,
      response: derived.response,
      pairingSecret,
    });
    if (!finalized.key.equals(derived.session.key)) {
      throw new Error(`${vector.id}: finalize key mismatch`);
    }

    let tamperRejected = false;
    try {
      finalizeNoiseV3Response({
        state: init.state,
        response: {
          ...derived.response,
          proof: toBase64Url(crypto.randomBytes(32)),
        },
        pairingSecret,
      });
    } catch {
      tamperRejected = true;
    }
    if (!tamperRejected) {
      throw new Error(`${vector.id}: tampered proof was accepted`);
    }
  }

  process.stdout.write(`[integration] noise-v3 conformance passed (${vectors.length})\n`);
}

main().catch((error) => {
  console.error(`[integration] conformance FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
