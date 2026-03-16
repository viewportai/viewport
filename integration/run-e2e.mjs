import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { RedisMemoryServer } from 'redis-memory-server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_ROOT = path.resolve(ROOT, '..');
const PLATFORM_ROOT = process.env.PLATFORM_ROOT
  ? path.resolve(process.env.PLATFORM_ROOT)
  : path.resolve(LEGACY_ROOT, 'platform');

function resolveExistingDir(...candidates) {
  for (const candidate of candidates) {
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Unable to resolve directory from candidates: ${candidates.join(', ')}`);
}

const SERVER_DIR = resolveExistingDir(
  path.join(ROOT, 'server'),
  path.join(PLATFORM_ROOT, 'apps', 'api'),
  path.join(LEGACY_ROOT, 'platform', 'apps', 'api'),
  path.join(LEGACY_ROOT, 'server'),
);
const RELAY_DIR = resolveExistingDir(
  path.join(ROOT, 'services', 'relay'),
  path.join(ROOT, 'relay'),
  path.join(LEGACY_ROOT, 'relay'),
);
const DAEMON_DIR = resolveExistingDir(
  path.join(ROOT, 'packages', 'daemon'),
  path.join(ROOT, 'daemon'),
  path.join(LEGACY_ROOT, 'daemon'),
);

const REQUESTED_SERVER_PORT = Number(process.env.SERVER_PORT || 7780);
const REQUESTED_RELAY_PORT = Number(process.env.RELAY_PORT || 7781);
const REQUESTED_RELAY2_PORT = Number(process.env.RELAY2_PORT || REQUESTED_RELAY_PORT + 1);
const REQUESTED_DAEMON_PORT = Number(process.env.DAEMON_PORT || 7790);
const INTEGRATION_SCENARIO = (process.env.INTEGRATION_SCENARIO || 'full').toLowerCase();
const INTEGRATION_BACKPLANE_MODE = (process.env.INTEGRATION_BACKPLANE_MODE || '').toLowerCase();
const INTEGRATION_DUAL_RELAY = process.env.INTEGRATION_DUAL_RELAY;
const ASSERT_ZERO_TRUST = (process.env.INTEGRATION_ASSERT_ZERO_TRUST ?? '1') !== '0';
const RELAY_ADMIN_TOKEN =
  process.env.RELAY_ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
const RELAY_INTERNAL_KEY =
  process.env.RELAY_INTERNAL_KEY || crypto.randomBytes(24).toString('hex');
const RELAY_BUS_HMAC_KEY =
  process.env.RELAY_BUS_HMAC_KEY || crypto.randomBytes(24).toString('hex');
const LOAD_CLIENTS = Math.max(1, Number(process.env.INTEGRATION_LOAD_CLIENTS || 24));
const LOAD_PARALLELISM = Math.max(1, Number(process.env.INTEGRATION_LOAD_PARALLELISM || 6));
const SOAK_MESSAGES = Math.max(1, Number(process.env.INTEGRATION_SOAK_MESSAGES || 24));
const SOAK_DELAY_MS = Math.max(0, Number(process.env.INTEGRATION_SOAK_DELAY_MS || 100));
const DAEMON_HEALTH_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.INTEGRATION_DAEMON_HEALTH_TIMEOUT_MS || 120_000),
);
let noiseV3Module = null;
let pairingOffersModule = null;

function safeWorkspaceId(workspaceId) {
  return workspaceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function resolvePhpBin() {
  if (process.env.PHP_BIN && process.env.PHP_BIN.trim()) {
    return process.env.PHP_BIN.trim();
  }
  const probe = spawnSync('/bin/zsh', ['-lc', 'command -v php84 || command -v php'], {
    encoding: 'utf8',
  });
  if (probe.status === 0) {
    const candidate = probe.stdout.trim().split('\n')[0]?.trim();
    if (candidate) return candidate;
  }
  return 'php';
}

const PHP_BIN = resolvePhpBin();

function log(step, details = '') {
  const suffix = details ? ` ${details}` : '';
  process.stdout.write(`[integration] ${step}${suffix}\n`);
}

function spawnProc(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk.toString('utf8')}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk.toString('utf8')}`);
  });

  return child;
}

async function waitForProcessExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function upsertEnvFile(filePath, values, examplePath = null) {
  let source = '';
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch {
    if (examplePath) {
      try {
        source = await fs.readFile(examplePath, 'utf8');
      } catch {
        source = '';
      }
    }
  }

  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/i.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      updated.push(`${key}=${value}`);
    }
  }

  const next = `${updated.filter((line) => line !== undefined).join('\n').replace(/\n*$/, '\n')}`;
  await fs.writeFile(filePath, next, 'utf8');
}

async function fetchRelayAdminJson(relayHttpBase, pathname) {
  const response = await fetch(`${relayHttpBase}${pathname}`, {
    headers: {
      authorization: `Bearer ${RELAY_ADMIN_TOKEN}`,
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `GET ${pathname} expected 200 got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function expectNoRelayStatus(ws, predicate, timeoutMs = 1_500) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(undefined);
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed?.type === 'relay_status' && predicate(parsed)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          reject(new Error(`Unexpected relay_status frame: ${JSON.stringify(parsed)}`));
        }
      } catch {
        // ignore
      }
    }

    ws.on('message', onMessage);
  });
}

async function post(serverUrl, pathname, body, expectedStatus = 200, extraHeaders = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));

  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${pathname} expected ${expectedStatus} got ${response.status}: ${JSON.stringify(json)}`,
    );
  }

  return json;
}

async function postInternal(serverUrl, pathname, body, expectedStatus = 200) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-internal-key': RELAY_INTERNAL_KEY,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${pathname} expected ${expectedStatus} got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function postJson(baseUrl, pathname, body, expectedStatus = 200, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${pathname} expected ${expectedStatus} got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function issueClientRelayTokenWithRetry(
  serverUrl,
  workspaceId,
  clientAuthToken,
  userAuthToken,
  ttlSeconds = null,
  maxAttempts = 20,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(`${serverUrl}/api/poc/relay-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userAuthToken}`,
      },
      body: JSON.stringify({
        role: 'client',
        workspaceId,
        credential: clientAuthToken,
        ...(typeof ttlSeconds === 'number' ? { ttlSeconds } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 200 && json?.ok === true) return json;
    if (res.status === 409 && json?.reason === 'DAEMON_PUBLIC_KEY_NOT_REGISTERED') {
      await sleep(250);
      continue;
    }
    throw new Error(`issue relay token failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  throw new Error('Timed out waiting for daemon public key registration');
}

function toBase64Url(buffer) {
  return buffer.toString('base64url');
}

function fromBase64Url(input) {
  return Buffer.from(input, 'base64url');
}

function derivePairingChannelKey(sharedSecret, saltLabel) {
  const salt = crypto.createHash('sha256').update(saltLabel, 'utf8').digest();
  return crypto.hkdfSync(
    'sha256',
    sharedSecret,
    salt,
    Buffer.from('viewport-relay-pairing-channel-v1', 'utf8'),
    32,
  );
}

function encryptPairingPayload(key, plaintext, aadLabel) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aadLabel, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encIv: toBase64Url(iv),
    encTag: toBase64Url(tag),
    encCiphertext: toBase64Url(ciphertext),
  };
}

function decryptPairingPayload(key, encrypted, aadLabel) {
  const iv = fromBase64Url(encrypted.encIv);
  const tag = fromBase64Url(encrypted.encTag);
  const ciphertext = fromBase64Url(encrypted.encCiphertext);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aadLabel, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function envelopeAad({ profile, sessionId, epoch, seq }) {
  return Buffer.from(`viewport-relay-envelope-v2|${profile}|${sessionId}|${epoch}|${seq}`, 'utf8');
}

function encryptEnvelope(session, plaintext) {
  session.txSeq += 1;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', session.key, iv);
  cipher.setAAD(
    envelopeAad({
      profile: session.profile,
      sessionId: session.sessionId,
      epoch: session.epoch,
      seq: session.txSeq,
    }),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    type: 'e2ee',
    version: 2,
    profile: session.profile,
    sessionId: session.sessionId,
    epoch: session.epoch,
    seq: session.txSeq,
    iv: toBase64Url(iv),
    tag: toBase64Url(tag),
    ciphertext: toBase64Url(ciphertext),
  };
}

function tamperEnvelopeAuthTag(envelope) {
  const tag = fromBase64Url(envelope.tag);
  tag[0] = tag[0] ^ 0x01;
  return {
    ...envelope,
    tag: toBase64Url(tag),
  };
}

function tamperBase64Url(input) {
  const buf = fromBase64Url(input);
  if (buf.length === 0) return input;
  buf[0] = buf[0] ^ 0x01;
  return toBase64Url(buf);
}

function decryptEnvelope(session, raw) {
  const parsed = JSON.parse(raw);
  if (
    parsed.type !== 'e2ee' ||
    parsed.version !== 2 ||
    parsed.profile !== session.profile ||
    parsed.sessionId !== session.sessionId ||
    parsed.epoch !== session.epoch ||
    typeof parsed.seq !== 'number'
  ) {
    throw new Error('invalid session envelope');
  }
  const iv = fromBase64Url(parsed.iv);
  const tag = fromBase64Url(parsed.tag);
  const ciphertext = fromBase64Url(parsed.ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-gcm', session.key, iv);
  decipher.setAAD(
    envelopeAad({
      profile: parsed.profile,
      sessionId: parsed.sessionId,
      epoch: parsed.epoch,
      seq: parsed.seq,
    }),
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function decodeJwtHeader(token) {
  const [headerPart] = token.split('.');
  if (!headerPart) return {};
  try {
    return JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function decodeJwtPayload(token) {
  const [, payloadPart] = token.split('.');
  if (!payloadPart) return {};
  try {
    return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function deriveRelayPairingSecret({
  offerId,
  redeemSecret,
  trustAnchor,
  clientPublicKey,
  daemonPublicKey,
}) {
  const prefix = 'viewport-relay-policyc-pair-v1';
  const salt = crypto
    .createHash('sha256')
    .update(
      [prefix, offerId, trustAnchor, clientPublicKey.trim(), daemonPublicKey.trim()].join('\n'),
      'utf8',
    )
    .digest();
  const ikm = Buffer.from(redeemSecret, 'utf8');
  const derived = crypto.hkdfSync('sha256', ikm, salt, Buffer.from(prefix, 'utf8'), 32);
  const bytes = Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
  return bytes.toString('base64url');
}

function verifyRs256JwtWithJwks(token, jwks) {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error('malformed JWT');
  }
  const header = decodeJwtHeader(token);
  if (header.alg !== 'RS256') {
    throw new Error(`expected RS256 relay token, got ${String(header.alg)}`);
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const key = keys.find((entry) => entry?.kid === header.kid);
  if (!key || key.kty !== 'RSA' || !key.n || !key.e) {
    throw new Error(`JWKS missing RSA key for kid=${String(header.kid)}`);
  }

  const publicKey = crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: key.n,
      e: key.e,
    },
    format: 'jwk',
  });
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
    publicKey,
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!verified) {
    throw new Error('RS256 relay token signature verification failed against JWKS');
  }
}

function getNoiseV3Module() {
  if (!noiseV3Module) {
    throw new Error('noise-v3 module not initialized');
  }
  return noiseV3Module;
}

async function loadNoiseV3Module() {
  const moduleUrl = pathToFileURL(path.join(DAEMON_DIR, 'dist', 'relay', 'bridge-noise-v3.js')).href;
  noiseV3Module = await import(moduleUrl);
}

function getPairingOffersModule() {
  if (!pairingOffersModule) {
    throw new Error('pairing-offers module not initialized');
  }
  return pairingOffersModule;
}

async function loadPairingOffersModule() {
  const moduleUrl = pathToFileURL(path.join(DAEMON_DIR, 'dist', 'server', 'pairing-offers.js')).href;
  pairingOffersModule = await import(moduleUrl);
}

function rogueCanValidateSessionProof(responseFrame, daemonPublicKey, initFrame, pairingSecret) {
  try {
    const noise = getNoiseV3Module();
    const rogueInit = noise.createNoiseV3Init({
      profile: responseFrame.profile,
      requestId: responseFrame.requestId,
      daemonPublicKey,
      previousSessionId: initFrame.previousSessionId,
      pairingPeerId: initFrame.pairingPeerId,
      pairingSecret:
        responseFrame.profile === 'noise-ikpsk2' && typeof pairingSecret === 'string'
          ? fromBase64Url(pairingSecret)
          : undefined,
    });
    noise.finalizeNoiseV3Response({
      state: rogueInit.state,
      response: responseFrame,
      pairingSecret:
        responseFrame.profile === 'noise-ikpsk2' && typeof pairingSecret === 'string'
          ? fromBase64Url(pairingSecret)
          : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

async function establishRelaySessionViaKeyExchange(
  ws,
  { daemonPublicKey, profile = 'noise-ik', pairingPeerId, pairingSecret, previousSessionId },
  timeoutMs = 10_000,
) {
  const noise = getNoiseV3Module();
  const pairingSecretBytes = pairingSecret ? fromBase64Url(pairingSecret) : undefined;
  const init = noise.createNoiseV3Init({
    daemonPublicKey,
    profile,
    previousSessionId,
    pairingPeerId,
    pairingSecret: pairingSecretBytes,
  });
  const initFrame = init.frame;
  const requestId = initFrame.requestId;

  ws.send(JSON.stringify(initFrame));

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for relay key exchange response'));
    }, timeoutMs);

    function onMessage(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (
        parsed?.type !== 'relay_key_exchange_response' ||
        parsed?.requestId !== requestId ||
        parsed?.version !== 3 ||
        parsed?.profile !== profile
      ) {
        return;
      }

      try {
        const session = noise.finalizeNoiseV3Response({
          state: init.state,
          response: parsed,
          pairingSecret: pairingSecretBytes,
        });
        clearTimeout(timeout);
        ws.off('message', onMessage);
        resolve({
          key: Buffer.from(session.key),
          profile: session.profile,
          sessionId: session.sessionId,
          epoch: session.epoch,
          txSeq: 0,
          initFrame,
          responseFrame: parsed,
        });
      } catch (error) {
        clearTimeout(timeout);
        ws.off('message', onMessage);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    ws.on('message', onMessage);
  });
}

async function openWs(url, options = {}, timeoutMs = 8_000) {
  const ws = new WebSocket(url, options);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WS open timeout: ${url}`)), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  return ws;
}

async function waitForJsonWsMessage(ws, predicate, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket json message'));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (predicate(parsed)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore non-json frames
      }
    }

    ws.on('message', onMessage);
  });
}

function createBufferedMessageStream(ws, decodeFrame) {
  const buffered = [];
  const waiters = [];

  function deliver(message) {
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex !== -1) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    buffered.push(message);
  }

  function onMessage(raw) {
    try {
      const message = decodeFrame(raw.toString('utf8'));
      if (message !== undefined) {
        deliver(message);
      }
    } catch {
      // ignore frames that do not match the expected codec
    }
  }

  ws.on('message', onMessage);

  return {
    waitFor(predicate, timeoutMs = 10_000) {
      const bufferedIndex = buffered.findIndex(predicate);
      if (bufferedIndex !== -1) {
        const [match] = buffered.splice(bufferedIndex, 1);
        return Promise.resolve(match);
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timeout: setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx !== -1) waiters.splice(idx, 1);
            reject(new Error('Timed out waiting for buffered websocket message'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close() {
      ws.off('message', onMessage);
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error('Buffered websocket stream closed'));
      }
    },
  };
}

function createRelayMessageBuffer(ws, session) {
  return createBufferedMessageStream(ws, (raw) => JSON.parse(decryptEnvelope(session, raw)));
}

function createJsonMessageBuffer(ws) {
  return createBufferedMessageStream(ws, (raw) => JSON.parse(raw));
}

async function requestDirectSyncSnapshot(ws, buffer) {
  const requestId = `sync-direct-${crypto.randomUUID()}`;
  ws.send(
    JSON.stringify({
      type: 'sync-request',
      requestId,
    }),
  );
  const snapshot = await buffer.waitFor((msg) => msg.type === 'sync-snapshot', 10_000);
  const ack = await buffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === requestId,
    10_000,
  );
  if (ack.status !== 'ok') {
    throw new Error(`direct sync failed: ${JSON.stringify(ack)}`);
  }
  return snapshot;
}

async function requestRelaySyncSnapshot(ws, session) {
  const buffer = createRelayMessageBuffer(ws, session);
  try {
    return await requestRelaySyncSnapshotBuffered(ws, session, buffer);
  } finally {
    buffer.close();
  }
}

async function requestRelaySyncSnapshotBuffered(ws, session, buffer) {
  const requestId = `sync-relay-${crypto.randomUUID()}`;
  ws.send(
    JSON.stringify(
      encryptEnvelope(
        session,
        JSON.stringify({
          type: 'sync-request',
          requestId,
        }),
      ),
    ),
  );
  const snapshot = await buffer.waitFor((msg) => msg.type === 'sync-snapshot', 10_000);
  const ack = await buffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === requestId,
    10_000,
  );
  if (ack.status !== 'ok') {
    throw new Error(`relay sync failed: ${JSON.stringify(ack)}`);
  }
  return snapshot;
}

async function expectWsOpenRejected(url, options = {}, timeoutMs = 8_000) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timeout = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error(`Expected WS connection rejection for ${url}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('close');
    }

    ws.once('open', () => {
      cleanup();
      ws.close();
      reject(new Error(`Expected WS connection rejection but connection opened: ${url}`));
    });
    ws.once('error', () => {
      cleanup();
      resolve();
    });
    ws.once('close', (code) => {
      if (code === 1000) return;
      cleanup();
      resolve();
    });
  });
}

async function expectWsCloseCode(url, options, expectedCode, timeoutMs = 8_000) {
  const ws = await openWs(url, options, timeoutMs);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error(`Expected ws close code ${expectedCode}, but socket stayed open`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      ws.removeAllListeners('close');
      ws.removeAllListeners('error');
    }

    ws.once('error', (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    ws.once('close', (code) => {
      cleanup();
      if (code !== expectedCode) {
        reject(new Error(`Expected ws close code ${expectedCode}, got ${code}`));
        return;
      }
      resolve(undefined);
    });
  });
}

async function waitForDecrypted(ws, session, predicate, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for decrypted relay message'));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const decrypted = decryptEnvelope(session, raw.toString('utf8'));
        const parsed = JSON.parse(decrypted);
        if (predicate(parsed)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore non-envelope relay status frames
      }
    }

    ws.on('message', onMessage);
  });
}

async function expectNoDecryptedMatch(ws, session, predicate, timeoutMs = 1_500) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(undefined);
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const decrypted = decryptEnvelope(session, raw.toString('utf8'));
        const parsed = JSON.parse(decrypted);
        if (predicate(parsed)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          reject(
            new Error(`Unexpected decrypted message matched predicate: ${JSON.stringify(parsed)}`),
          );
        }
      } catch {
        // Ignore relay status/control/non-envelope frames.
      }
    }

    ws.on('message', onMessage);
  });
}

async function waitForRelayStatus(ws, predicate, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for relay_status frame'));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed?.type === 'relay_status' && predicate(parsed)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore
      }
    }

    ws.on('message', onMessage);
  });
}

async function writeIntegrationFakeAgent(tmpHome) {
  const pluginDir = path.join(tmpHome, 'plugins', 'viewport-agent-integration-fake');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, 'package.json'),
    JSON.stringify(
      {
        name: 'viewport-agent-integration-fake',
        version: '0.0.1',
        private: true,
        type: 'module',
        main: 'index.js',
        viewport: {
          type: 'agent',
          agentId: 'integration-fake',
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginDir, 'index.js'),
    `import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

class IntegrationFakeSession extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.state = 'running';
    this.messageCounter = 0;
  }

  async sendPrompt(text) {
    this.emit('message', {
      type: 'user_message',
      text,
      messageId: \`\${this.id}-user-\${++this.messageCounter}\`,
      timestamp: Date.now(),
    });
    queueMicrotask(() => {
      this.emit('message', {
        type: 'agent_message',
        text: \`integration-fake: \${text}\`,
        messageId: \`\${this.id}-agent-\${++this.messageCounter}\`,
        timestamp: Date.now(),
      });
    });
  }

  async kill() {
    this.state = 'completed';
    this.emit('state-change', this.state);
    this.emit('ended', 'killed');
  }
}

function createAdapter() {
  return {
    agentId: 'integration-fake',
    async startSession(_cwd, options = {}) {
      const session = new IntegrationFakeSession(crypto.randomUUID());
      const initialPrompt = options.initialPrompt?.trim();
      if (initialPrompt) {
        setTimeout(() => {
          void session.sendPrompt(initialPrompt);
        }, 0);
      }
      return session;
    },
    async resumeSession(sessionId, _cwd, options = {}) {
      const session = new IntegrationFakeSession(sessionId);
      const initialPrompt = options.initialPrompt?.trim();
      if (initialPrompt) {
        setTimeout(() => {
          void session.sendPrompt(initialPrompt);
        }, 0);
      }
      return session;
    },
  };
}

const definition = {
  id: 'integration-fake',
  displayName: 'Integration Fake',
  tier: 'sdk',
  defaults: {
    commitOn: [],
    autoApprove: [],
    requireApproval: [],
    deny: [],
  },
  capabilities: {
    structuredToolCalls: true,
    permissionCallbacks: false,
    tokenUsage: false,
    resume: true,
    extendedThinking: false,
  },
  detection: {
    check: async () => true,
    description: 'Integration fake agent',
  },
  createAdapter: async () => createAdapter(),
};

export default definition;
`,
    'utf8',
  );

  await fs.writeFile(
    path.join(tmpHome, 'config.json'),
    JSON.stringify(
      {
        defaults: {
          agent: 'integration-fake',
          gitTracker: {
            enabled: false,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function waitForPairingResponse(ws, responseType, requestId, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${responseType}`));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed?.type === responseType && parsed?.requestId === requestId) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore
      }
    }

    ws.on('message', onMessage);
  });
}

async function pairClientOverRelay({
  serverUrl,
  relayWsBase,
  workspaceId,
  clientId,
  clientAuthToken,
  userAuthToken,
}) {
  const pairingIssue = await post(serverUrl, '/api/poc/pairing-token', {
    workspaceId,
    credential: clientAuthToken,
  }, 200, {
    authorization: `Bearer ${userAuthToken}`,
  });
  const pairingRelayBase =
    typeof pairingIssue?.claims?.relayWsBaseUrl === 'string' && pairingIssue.claims.relayWsBaseUrl
      ? pairingIssue.claims.relayWsBaseUrl
      : relayWsBase;
  const daemonPublicKey = pairingIssue?.claims?.daemonPublicKey;
  if (typeof daemonPublicKey !== 'string' || daemonPublicKey.length < 80) {
    throw new Error('pairing token response missing daemonPublicKey');
  }

  const ws = await openWs(
    `${pairingRelayBase}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: {
        authorization: `Bearer ${pairingIssue.relayToken}`,
      },
    },
  );

  try {
    const offerRequestId = `pair-offer-${crypto.randomUUID()}`;
    const channelEcdh = crypto.createECDH('prime256v1');
    channelEcdh.generateKeys();
    ws.send(
      JSON.stringify({
        type: 'relay_pairing_offer_request',
        requestId: offerRequestId,
        ttlSeconds: 600,
        clientChannelPublicKey: toBase64Url(channelEcdh.getPublicKey()),
      }),
    );
    const offerResponse = await waitForPairingResponse(
      ws,
      'relay_pairing_offer_response',
      offerRequestId,
      12_000,
    );
    if (!offerResponse?.ok) {
      throw new Error(`pairing offer failed: ${JSON.stringify(offerResponse)}`);
    }
    if (
      typeof offerResponse?.daemonChannelPublicKey !== 'string' ||
      typeof offerResponse?.encIv !== 'string' ||
      typeof offerResponse?.encTag !== 'string' ||
      typeof offerResponse?.encCiphertext !== 'string'
    ) {
      throw new Error(`pairing offer missing encrypted envelope: ${JSON.stringify(offerResponse)}`);
    }
    const channelShared = channelEcdh.computeSecret(fromBase64Url(offerResponse.daemonChannelPublicKey));
    const channelKey = derivePairingChannelKey(channelShared, `offer:${offerRequestId}`);
    const offerPayload = JSON.parse(
      decryptPairingPayload(
        channelKey,
        {
          encIv: offerResponse.encIv,
          encTag: offerResponse.encTag,
          encCiphertext: offerResponse.encCiphertext,
        },
        `offer:${offerRequestId}`,
      ),
    );
    if (
      typeof offerPayload?.offerId !== 'string' ||
      typeof offerPayload?.redeemSecret !== 'string' ||
      typeof offerPayload?.trustAnchor !== 'string'
    ) {
      throw new Error(`invalid encrypted pairing offer payload: ${JSON.stringify(offerPayload)}`);
    }

    const pairing = getPairingOffersModule();
    const clientIdentity = pairing.createPairingClientIdentity();
    const redeemProof = pairing.createPairingRedeemProof({
      offerId: offerPayload.offerId,
      redeemSecret: offerPayload.redeemSecret,
      trustAnchor: offerPayload.trustAnchor,
      clientIdentity,
    });

    const redeemRequestId = `pair-redeem-${crypto.randomUUID()}`;
    const encryptedRedeem = encryptPairingPayload(
      channelKey,
      JSON.stringify({
        redeemSecret: offerPayload.redeemSecret,
        trustAnchor: offerPayload.trustAnchor,
        clientPublicKey: redeemProof.clientPublicKey,
        clientProof: redeemProof.clientProof,
      }),
      `redeem:${redeemRequestId}:${offerPayload.offerId}`,
    );

    const tamperedRedeemRequestId = `pair-redeem-tampered-${crypto.randomUUID()}`;
    ws.send(
      JSON.stringify({
        type: 'relay_pairing_redeem_request',
        requestId: tamperedRedeemRequestId,
        offerId: offerPayload.offerId,
        encIv: encryptedRedeem.encIv,
        encTag: tamperBase64Url(encryptedRedeem.encTag),
        encCiphertext: encryptedRedeem.encCiphertext,
      }),
    );
    const tamperedResponse = await waitForPairingResponse(
      ws,
      'relay_pairing_redeem_response',
      tamperedRedeemRequestId,
      12_000,
    );
    if (tamperedResponse?.ok === true) {
      throw new Error('tampered encrypted pairing redeem unexpectedly succeeded');
    }

    ws.send(
      JSON.stringify({
        type: 'relay_pairing_redeem_request',
        requestId: redeemRequestId,
        offerId: offerPayload.offerId,
        encIv: encryptedRedeem.encIv,
        encTag: encryptedRedeem.encTag,
        encCiphertext: encryptedRedeem.encCiphertext,
      }),
    );
    const redeemResponse = await waitForPairingResponse(
      ws,
      'relay_pairing_redeem_response',
      redeemRequestId,
      12_000,
    );
    if (!redeemResponse?.ok || !redeemResponse?.redeemed) {
      throw new Error(`pairing redeem failed: ${JSON.stringify(redeemResponse)}`);
    }
    if (redeemResponse?.redeemed?.relayPairingSecret !== undefined) {
      throw new Error('pairing redeem response exposed relayPairingSecret');
    }

    const replayRequestId = `pair-redeem-replay-${crypto.randomUUID()}`;
    ws.send(
      JSON.stringify({
        type: 'relay_pairing_redeem_request',
        requestId: replayRequestId,
        offerId: offerPayload.offerId,
        encIv: encryptedRedeem.encIv,
        encTag: encryptedRedeem.encTag,
        encCiphertext: encryptedRedeem.encCiphertext,
      }),
    );
    const replayResponse = await waitForPairingResponse(
      ws,
      'relay_pairing_redeem_response',
      replayRequestId,
      12_000,
    );
    if (replayResponse?.ok === true) {
      throw new Error('replayed pairing redeem unexpectedly succeeded');
    }

    await post(serverUrl, `/api/poc/workspaces/${encodeURIComponent(workspaceId)}/pair`, {
      clientId,
    }, 200, {
      authorization: `Bearer ${userAuthToken}`,
    });

    const pairingSecret = deriveRelayPairingSecret({
      offerId: offerPayload.offerId,
      redeemSecret: offerPayload.redeemSecret,
      trustAnchor: offerPayload.trustAnchor,
      clientPublicKey: redeemProof.clientPublicKey,
      daemonPublicKey: offerPayload.daemonPublicKey || daemonPublicKey,
    });

    return {
      daemonPublicKey,
      pairingPeerId: redeemResponse.redeemed.relayPairingPeerId,
      pairingSecret,
      sensitiveMarkers: {
        redeemSecret: offerPayload.redeemSecret,
        trustAnchor: offerPayload.trustAnchor,
      },
    };
  } finally {
    ws.close();
  }
}

async function waitForWsClose(ws, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket close')), timeoutMs);
    ws.once('close', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function openClientRelaySession({
  serverUrl,
  relayWsBase,
  workspaceId,
  clientAuthToken,
  userAuthToken,
  daemonPublicKey,
  profile,
  pairingPeerId,
  pairingSecret,
}) {
  const issue = await issueClientRelayTokenWithRetry(
    serverUrl,
    workspaceId,
    clientAuthToken,
    userAuthToken,
  );
  const ws = await openWs(
    `${relayWsBase}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: {
        authorization: `Bearer ${issue.relayToken}`,
      },
    },
  );
  const session = await establishRelaySessionViaKeyExchange(ws, {
    daemonPublicKey,
    profile,
    pairingPeerId,
    pairingSecret,
  });
  const buffer = createRelayMessageBuffer(ws, session);
  await requestRelaySyncSnapshotBuffered(ws, session, buffer);
  return { ws, session, buffer };
}

async function runLoadScenario({
  serverUrl,
  relayWsBase,
  workspaceId,
  workspaceDirectoryId,
  userId,
  userAuthToken,
  daemonPublicKey,
  profile,
  pairingPeerId,
  pairingSecret,
}) {
  log('load', `starting clients=${LOAD_CLIENTS} parallelism=${LOAD_PARALLELISM}`);
  let cursor = 0;
  const workers = [];
  const failures = [];

  for (let worker = 0; worker < LOAD_PARALLELISM; worker += 1) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= LOAD_CLIENTS) return;
          let ws;
          let relayBuffer = null;
          try {
            const login = await post(serverUrl, '/api/poc/users/login', {
              userId,
              clientName: `load-client-${idx}`,
              userAuthToken,
            });
            const opened = await openClientRelaySession({
              serverUrl,
              relayWsBase,
              workspaceId,
              clientAuthToken: login.clientAuthToken,
              userAuthToken,
              daemonPublicKey,
              profile,
              pairingPeerId,
              pairingSecret,
            });
            ws = opened.ws;
            relayBuffer = opened.buffer;
            ws.send(
              JSON.stringify(
                encryptEnvelope(
                  opened.session,
                  JSON.stringify({
                    type: 'list-sessions',
                    directoryId: workspaceDirectoryId,
                    limit: 3,
                    requestId: `load-${idx}`,
                  }),
                ),
              ),
            );
            const ack = await relayBuffer.waitFor(
              (msg) => msg.type === 'ack' && msg.requestId === `load-${idx}`,
              12_000,
            );
            if (ack.status !== 'ok') {
              throw new Error(`load-${idx} ack not ok: ${JSON.stringify(ack)}`);
            }
          } catch (error) {
            failures.push(`[client ${idx}] ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            relayBuffer?.close?.();
            ws?.close();
          }
        }
      })(),
    );
  }

  await Promise.all(workers);
  if (failures.length > 0) {
    throw new Error(`Load scenario failures (${failures.length}): ${failures.slice(0, 5).join('; ')}`);
  }
  log('load', 'pass');
}

async function runSoakScenario({
  ws,
  session,
  buffer,
  daemonPublicKey,
  profile,
  pairingPeerId,
  pairingSecret,
}) {
  log('soak', `sending ${SOAK_MESSAGES} encrypted requests to exercise rekey`);
  let activeSession = session;

  for (let i = 1; i <= SOAK_MESSAGES; i += 1) {
    const requestId = `soak-${i}`;
    ws.send(
      JSON.stringify(
        encryptEnvelope(
          activeSession,
          JSON.stringify({
            type: 'noop',
            requestId,
            payload: { i },
          }),
        ),
      ),
    );
    const ack = await buffer.waitFor(
      (msg) => msg.type === 'ack' && msg.requestId === requestId,
      12_000,
    );
    if (ack.errorCode === 'RATE_LIMITED') {
      throw new Error(`soak rate-limited for ${requestId}: ${JSON.stringify(ack)}`);
    }
    if (SOAK_DELAY_MS > 0) {
      // Keep request cadence below daemon command rate limits during long soak runs.
      // eslint-disable-next-line no-await-in-loop
      await sleep(SOAK_DELAY_MS);
    }
  }

  const nextSession = await establishRelaySessionViaKeyExchange(
    ws,
    {
      daemonPublicKey,
      profile,
      pairingPeerId,
      pairingSecret,
      previousSessionId: activeSession.sessionId,
    },
    12_000,
  );
  if (nextSession.epoch !== activeSession.epoch + 1) {
    throw new Error(`rekey produced unexpected epoch ${nextSession.epoch}`);
  }
  buffer.close();
  activeSession = nextSession;
  const nextBuffer = createRelayMessageBuffer(ws, activeSession);
  await requestRelaySyncSnapshotBuffered(ws, activeSession, nextBuffer);

  ws.send(
    JSON.stringify(
      encryptEnvelope(
        activeSession,
        JSON.stringify({
          type: 'noop',
          requestId: 'soak-post-rekey',
          payload: { postRekey: true },
        }),
      ),
    ),
  );
  const postRekeyAck = await nextBuffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === 'soak-post-rekey',
    12_000,
  );
  if (postRekeyAck.errorCode === 'RATE_LIMITED') {
    throw new Error(`soak post-rekey was rate-limited: ${JSON.stringify(postRekeyAck)}`);
  }

  nextBuffer.close();
  log('soak', 'pass');
}

async function runChaosScenario({
  relayProcB,
  ws,
  serverUrl,
  relayWsBase,
  workspaceId,
  workspaceDirectoryId,
  clientAuthToken,
  userAuthToken,
  daemonPublicKey,
  profile,
  pairingPeerId,
  pairingSecret,
}) {
  log('chaos', 'terminating relay-b to validate client recovery path');
  relayProcB.kill('SIGTERM');
  await waitForWsClose(ws, 12_000);

  const recovered = await openClientRelaySession({
    serverUrl,
    relayWsBase,
    workspaceId,
    clientAuthToken,
    userAuthToken,
    daemonPublicKey,
    profile,
    pairingPeerId,
    pairingSecret,
  });

  recovered.ws.send(
    JSON.stringify(
      encryptEnvelope(
        recovered.session,
        JSON.stringify({
          type: 'list-sessions',
          directoryId: workspaceDirectoryId,
          limit: 3,
          requestId: 'chaos-recovered',
        }),
      ),
    ),
  );
  const ack = await recovered.buffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === 'chaos-recovered',
    12_000,
  );
  recovered.buffer.close();
  recovered.ws.close();
  if (ack.status !== 'ok') {
    throw new Error('chaos recovery ack not ok');
  }
  log('chaos', 'pass');
}

async function runReplayScenario({
  daemonPort,
  serverUrl,
  relayWsBase,
  relayPort,
  relayProc,
  procs,
  workspaceId,
  clientAuthToken,
  userAuthToken,
  daemonPublicKey,
  profile,
  relayEnv,
}) {
  log('replay', 'launch via relay, generate missed events offline, then resume after relay restart');

  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-integration-project-'));
  await fs.writeFile(path.join(projectPath, 'README.md'), '# integration replay\n', 'utf8');

  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const directory = await postJson(daemonUrl, '/api/directories', { path: projectPath }, 201);
  const launchPrompt = 'launch replay scenario';

  const remote = await openClientRelaySession({
    serverUrl,
    relayWsBase,
    workspaceId,
    clientAuthToken,
    userAuthToken,
    daemonPublicKey,
    profile,
  });
  const remoteBuffer = remote.buffer;

  remote.ws.send(
    JSON.stringify(
      encryptEnvelope(
        remote.session,
        JSON.stringify({
          type: 'launch',
          directoryId: directory.id,
          prompt: launchPrompt,
          requestId: 'replay-launch',
        }),
      ),
    ),
  );

  const started = await remoteBuffer.waitFor((msg) => msg.type === 'session-started', 12_000);
  const sessionId = started.sessionId;
  const initialUser = await remoteBuffer.waitFor(
    (msg) =>
      msg.type === 'session-update' &&
      msg.sessionId === sessionId &&
      msg.update?.updateType === 'user-message' &&
      msg.update?.text === launchPrompt,
    12_000,
  );
  const launchAck = await remoteBuffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === 'replay-launch',
    12_000,
  );
  if (launchAck.status !== 'ok') {
    throw new Error(`replay launch failed: ${JSON.stringify(launchAck)}`);
  }
  const initialAgent = await remoteBuffer.waitFor(
    (msg) =>
      msg.type === 'session-update' &&
      msg.sessionId === sessionId &&
      msg.update?.updateType === 'agent-message' &&
      msg.update?.text === `integration-fake: ${launchPrompt}`,
    12_000,
  );
  const lastSeq =
    Math.max(Number(initialUser.seq ?? 0), Number(initialAgent.seq ?? 0)) || 0;
  remoteBuffer.close();
  remote.ws.close();

  relayProc.kill('SIGTERM');
  await waitForProcessExit(relayProc, 10_000);

  const daemonWs = await openWs(`ws://127.0.0.1:${daemonPort}/ws`);
  const daemonBuffer = createJsonMessageBuffer(daemonWs);
  await requestDirectSyncSnapshot(daemonWs, daemonBuffer);
  daemonWs.send(
    JSON.stringify({
      type: 'prompt',
      sessionId,
      text: 'missed while offline',
      requestId: 'local-offline-prompt',
    }),
  );
  const localAck = await daemonBuffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === 'local-offline-prompt',
    12_000,
  );
  daemonBuffer.close();
  daemonWs.close();
  if (localAck.status !== 'ok') {
    throw new Error(`local offline prompt failed: ${JSON.stringify(localAck)}`);
  }

  const restartedRelay = spawnProc('relay-a-restarted', 'node', ['dist/index.js'], RELAY_DIR, relayEnv);
  procs.push(restartedRelay);
  await waitForHealth(`http://127.0.0.1:${relayPort}/health`, 20_000);
  await sleep(1_000);

  const recovered = await openClientRelaySession({
    serverUrl,
    relayWsBase,
    workspaceId,
    clientAuthToken,
    userAuthToken,
    daemonPublicKey,
    profile,
  });
  const recoveredBuffer = recovered.buffer;
  recovered.ws.send(
    JSON.stringify(
      encryptEnvelope(
        recovered.session,
        JSON.stringify({
          type: 'subscribe',
          sessionId,
          lastSeq,
          requestId: 'replay-resubscribe',
        }),
      ),
    ),
  );

  const replayedUser = await recoveredBuffer.waitFor(
    (msg) =>
      msg.type === 'session-update' &&
      msg.sessionId === sessionId &&
      msg.update?.updateType === 'user-message' &&
      msg.update?.text === 'missed while offline',
    12_000,
  );
  const replayedAgent = await recoveredBuffer.waitFor(
    (msg) =>
      msg.type === 'session-update' &&
      msg.sessionId === sessionId &&
      msg.update?.updateType === 'agent-message' &&
      msg.update?.text === 'integration-fake: missed while offline',
    12_000,
  );
  const replayAck = await recoveredBuffer.waitFor(
    (msg) => msg.type === 'ack' && msg.requestId === 'replay-resubscribe',
    12_000,
  );
  recoveredBuffer.close();
  recovered.ws.close();
  if (replayAck.status !== 'ok' || replayAck.replayCount < 2) {
    throw new Error(`replay resubscribe failed: ${JSON.stringify(replayAck)}`);
  }
  if (!(Number(replayedUser.seq) > lastSeq && Number(replayedAgent.seq) > Number(replayedUser.seq))) {
    throw new Error(
      `unexpected replay sequence progression: ${JSON.stringify({
        lastSeq,
        replayedUserSeq: replayedUser.seq,
        replayedAgentSeq: replayedAgent.seq,
      })}`,
    );
  }

  const history = await fetch(
    `${daemonUrl}/api/directories/${encodeURIComponent(directory.id)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  ).then((response) => response.json());
  const historyTexts = (history.messages ?? [])
    .filter((message) => message.kind === 'text')
    .map((message) => message.text);
  if (
    !historyTexts.includes(launchPrompt) ||
    !historyTexts.includes(`integration-fake: ${launchPrompt}`) ||
    !historyTexts.includes('missed while offline') ||
    !historyTexts.includes('integration-fake: missed while offline')
  ) {
    throw new Error(`replay history missing expected messages: ${JSON.stringify(historyTexts)}`);
  }

  log('replay', 'pass');
  return restartedRelay;
}

async function main() {
  const procs = [];
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-integration-home-'));
  await writeIntegrationFakeAgent(tmpHome);
  const workspaceId = `workspace_integration_${Date.now().toString(36)}`;
  const workspaceDirectoryId = `${workspaceId}_directory`;
  const smokeOnly = INTEGRATION_SCENARIO === 'smoke';
  const backplaneSingleOnly = INTEGRATION_SCENARIO === 'backplane-single';
  const backplaneServerOnly = INTEGRATION_SCENARIO === 'backplane-server';
  const backplaneRedisOnly = INTEGRATION_SCENARIO === 'backplane-redis';
  const loadOnly = INTEGRATION_SCENARIO === 'load';
  const soakOnly = INTEGRATION_SCENARIO === 'soak';
  const chaosOnly = INTEGRATION_SCENARIO === 'chaos';
  const expiryOnly = INTEGRATION_SCENARIO === 'expiry';
  const replayOnly = INTEGRATION_SCENARIO === 'replay';
  const requestedBackplaneMode = backplaneSingleOnly
    ? 'single'
    : backplaneRedisOnly
      ? 'redis'
      : backplaneServerOnly
        ? 'server'
        : ['single', 'server', 'redis'].includes(INTEGRATION_BACKPLANE_MODE)
          ? INTEGRATION_BACKPLANE_MODE
          : 'server';
  const dualRelayMode = INTEGRATION_DUAL_RELAY === '1'
    ? true
    : INTEGRATION_DUAL_RELAY === '0'
      ? false
      : backplaneServerOnly || backplaneRedisOnly
        ? true
        : backplaneSingleOnly
          ? false
          : ['server', 'redis'].includes(requestedBackplaneMode)
            ? true
            : !(loadOnly || soakOnly || expiryOnly);
  let redisServer = null;

  try {
    const integrationLoginRate = Math.max(120, LOAD_CLIENTS * 4);
    const integrationRelayTokenRate = Math.max(240, LOAD_CLIENTS * 8);
    const reservedPorts = new Set();
    const serverPort = await findAvailablePort(REQUESTED_SERVER_PORT, reservedPorts);
    const relayPort = await findAvailablePort(REQUESTED_RELAY_PORT, reservedPorts);
    const relay2Port = await findAvailablePort(
      Math.max(REQUESTED_RELAY2_PORT, relayPort + 1),
      reservedPorts,
    );
    const daemonPort = await findAvailablePort(REQUESTED_DAEMON_PORT, reservedPorts);
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    const relayHttpA = `http://127.0.0.1:${relayPort}`;
    const relayHttpB = `http://127.0.0.1:${relay2Port}`;
    const relayWsA = `ws://127.0.0.1:${relayPort}/ws`;
    const relayWsB = dualRelayMode ? `ws://127.0.0.1:${relay2Port}/ws` : relayWsA;
    let redisUrl = null;

    if (requestedBackplaneMode === 'redis') {
      redisServer = new RedisMemoryServer();
      const redisHost = await redisServer.getHost();
      const redisPort = await redisServer.getPort();
      redisUrl = `redis://${redisHost}:${redisPort}`;
      log('redis', `started ${redisUrl}`);
    }

    log(
      'ports',
      `server=${serverPort} relayA=${relayPort}${dualRelayMode ? ` relayB=${relay2Port}` : ''} daemon=${daemonPort}`,
    );

    const serverEnvValues = {
      APP_ENV: 'local',
      APP_URL: `http://127.0.0.1:${serverPort}`,
      POC_RELAY_HTTP_URL: `http://127.0.0.1:${relayPort}`,
      POC_RELAY_ADMIN_TOKEN: RELAY_ADMIN_TOKEN,
      POC_RELAY_INTERNAL_KEY: RELAY_INTERNAL_KEY,
      POC_RELAY_DEBUG_ENABLED: '1',
      ...(expiryOnly ? { POC_RELAY_TOKEN_TTL_SECONDS: '30' } : {}),
      POC_MOCK_USER_BOOTSTRAP_ENABLED: '1',
      POC_RATE_LIMIT_API_PER_MINUTE: '5000',
      POC_RATE_LIMIT_LOGIN_PER_MINUTE: String(integrationLoginRate),
      POC_RATE_LIMIT_RELAY_TOKEN_PER_MINUTE: String(integrationRelayTokenRate),
      POC_RATE_LIMIT_INTERNAL_PER_MINUTE: '5000',
    };

    await upsertEnvFile(
      path.join(SERVER_DIR, '.env'),
      serverEnvValues,
      path.join(SERVER_DIR, '.env.example'),
    );

    log('migrate', 'fresh sqlite schema');
    const migrate = spawn(PHP_BIN, ['artisan', 'migrate:fresh', '--force'], {
      cwd: SERVER_DIR,
      stdio: 'inherit',
    });
    const migrateCode = await new Promise((resolve) => migrate.on('exit', resolve));
    if (migrateCode !== 0) {
      throw new Error(`migrate:fresh failed with code ${migrateCode}`);
    }
    const clearConfig = spawn(PHP_BIN, ['artisan', 'config:clear'], {
      cwd: SERVER_DIR,
      stdio: 'inherit',
    });
    const clearConfigCode = await new Promise((resolve) => clearConfig.on('exit', resolve));
    if (clearConfigCode !== 0) {
      throw new Error(`config:clear failed with code ${clearConfigCode}`);
    }

    log('start', 'server');
    const serverProc = spawnProc(
      'server',
      PHP_BIN,
      ['artisan', 'serve', '--host=127.0.0.1', `--port=${serverPort}`],
      SERVER_DIR,
      serverEnvValues,
    );
    procs.push(serverProc);

    log('start', 'relay A');
    const buildRelay = spawn('npm', ['run', 'build'], { cwd: RELAY_DIR, stdio: 'inherit' });
    const relayBuildCode = await new Promise((resolve) => buildRelay.on('exit', resolve));
    if (relayBuildCode !== 0) {
      throw new Error(`relay build failed with code ${relayBuildCode}`);
    }
    const relayAEnv = {
      PORT: String(relayPort),
      SERVER_URL: serverUrl,
      RELAY_TLS: '0',
      RELAY_ADMIN_TOKEN,
      RELAY_ENABLE_ADMIN_HTTP: '1',
      RELAY_INTERNAL_KEY,
      RELAY_BUS_HMAC_KEY,
      ...(redisUrl ? { RELAY_REDIS_URL: redisUrl } : {}),
      RELAY_ID: 'relay-a',
      RELAY_PUBLIC_WS_BASE_URL: relayWsA,
      RELAY_BACKPLANE_MODE: requestedBackplaneMode,
      RELAY_BUS_ENABLED: dualRelayMode && requestedBackplaneMode !== 'single' ? '1' : '0',
      RELAY_CLIENT_REDIRECT_ENABLED: dualRelayMode && requestedBackplaneMode !== 'single' ? '1' : '0',
      RELAY_BUS_PULL_WAIT_MS: '500',
    };
    let relayProc = spawnProc('relay-a', 'node', ['dist/index.js'], RELAY_DIR, relayAEnv);
    procs.push(relayProc);
    let relayProcB = null;
    let relayBEnv = null;
    if (dualRelayMode) {
      log('start', 'relay B');
      relayBEnv = {
        PORT: String(relay2Port),
        SERVER_URL: serverUrl,
        RELAY_TLS: '0',
        RELAY_ADMIN_TOKEN,
        RELAY_ENABLE_ADMIN_HTTP: '1',
        RELAY_INTERNAL_KEY,
        RELAY_BUS_HMAC_KEY,
        ...(redisUrl ? { RELAY_REDIS_URL: redisUrl } : {}),
        RELAY_ID: 'relay-b',
        RELAY_PUBLIC_WS_BASE_URL: relayWsB,
        RELAY_BACKPLANE_MODE: requestedBackplaneMode,
        RELAY_BUS_ENABLED: requestedBackplaneMode !== 'single' ? '1' : '0',
        RELAY_CLIENT_REDIRECT_ENABLED: requestedBackplaneMode !== 'single' ? '1' : '0',
        RELAY_BUS_PULL_WAIT_MS: '500',
      };
      relayProcB = spawnProc('relay-b', 'node', ['dist/index.js'], RELAY_DIR, relayBEnv);
      procs.push(relayProcB);
    }

    log('build', 'daemon');
    const buildDaemon = spawn('npm', ['run', 'build'], { cwd: DAEMON_DIR, stdio: 'inherit' });
    const buildCode = await new Promise((resolve) => buildDaemon.on('exit', resolve));
    if (buildCode !== 0) {
      throw new Error(`daemon build failed with code ${buildCode}`);
    }
    await loadNoiseV3Module();
    await loadPairingOffersModule();

    await waitForHealth(`${serverUrl}/api/health`);
    await waitForHealth(`${relayHttpA}/health`);
    if (dualRelayMode) {
      await waitForHealth(`${relayHttpB}/health`);
    }

    const relayStateA = await fetchRelayAdminJson(relayHttpA, '/state');
    if (relayStateA?.backplaneMode !== requestedBackplaneMode) {
      throw new Error(
        `relay-a backplane mode mismatch: expected ${requestedBackplaneMode}, got ${String(relayStateA?.backplaneMode)}`,
      );
    }
    if (requestedBackplaneMode === 'single') {
      if (relayStateA?.busEnabled !== false || relayStateA?.clientRedirectEnabled !== false) {
        throw new Error(
          `single backplane relay should disable bus and redirect: ${JSON.stringify({
            busEnabled: relayStateA?.busEnabled,
            clientRedirectEnabled: relayStateA?.clientRedirectEnabled,
          })}`,
        );
      }
    } else if (dualRelayMode) {
      if (relayStateA?.busEnabled !== true || relayStateA?.clientRedirectEnabled !== true) {
        throw new Error(
          `${requestedBackplaneMode} backplane relay-a should enable bus and redirect: ${JSON.stringify({
            busEnabled: relayStateA?.busEnabled,
            clientRedirectEnabled: relayStateA?.clientRedirectEnabled,
          })}`,
        );
      }
    }
    if (dualRelayMode) {
      const relayStateB = await fetchRelayAdminJson(relayHttpB, '/state');
      if (relayStateB?.backplaneMode !== requestedBackplaneMode) {
        throw new Error(
          `relay-b backplane mode mismatch: expected ${requestedBackplaneMode}, got ${String(relayStateB?.backplaneMode)}`,
        );
      }
      if (requestedBackplaneMode === 'server' || requestedBackplaneMode === 'redis') {
        if (relayStateB?.busEnabled !== true || relayStateB?.clientRedirectEnabled !== true) {
          throw new Error(
            `${requestedBackplaneMode} backplane relay-b should enable bus and redirect: ${JSON.stringify({
              busEnabled: relayStateB?.busEnabled,
              clientRedirectEnabled: relayStateB?.clientRedirectEnabled,
            })}`,
          );
        }
      }
    }

    log('api', 'login client + enroll workspace');
    const login = await post(serverUrl, '/api/poc/users/login', {
      userId: 'user_demo',
      clientName: 'integration-client',
    });
    const authHeaders = { authorization: `Bearer ${login.userAuthToken}` };
    const enroll = await post(serverUrl, '/api/poc/workspaces/enroll', {
      workspaceId,
    }, 200, authHeaders);

    if (ASSERT_ZERO_TRUST) {
      const preDaemonClientIssue = await post(
        serverUrl,
        '/api/poc/relay-token',
        {
          role: 'client',
          workspaceId,
          credential: login.clientAuthToken,
        },
        409,
        authHeaders,
      );
      if (preDaemonClientIssue?.reason !== 'DAEMON_PUBLIC_KEY_NOT_REGISTERED') {
        throw new Error(
          `Expected DAEMON_PUBLIC_KEY_NOT_REGISTERED before daemon key registration, got ${JSON.stringify(preDaemonClientIssue)}`,
        );
      }
    }

    log('start', 'daemon (native relay runtime)');
    const daemonProc = spawnProc(
      'daemon',
      'node',
      [
        'dist/index.js',
        'start',
        '--foreground',
        '--listen',
        `127.0.0.1:${daemonPort}`,
        '--relay',
        '--relay-endpoint',
        relayWsA,
        '--relay-server',
        serverUrl,
        '--relay-workspace',
        workspaceId,
        '--relay-enroll-token',
        enroll.workspaceEnrollToken,
      ],
      DAEMON_DIR,
      {
        VIEWPORT_HOME: tmpHome,
        VIEWPORT_TLS: '0',
        ...(soakOnly ? { VIEWPORT_RELAY_KEY_ROTATE_AFTER_MESSAGES: '8' } : {}),
      },
    );
    procs.push(daemonProc);

    // Daemon startup can take longer than relay/server in CI-like environments
    // because discovery and adapter probing happen before listen readiness.
    await waitForHealth(`http://127.0.0.1:${daemonPort}/health`, DAEMON_HEALTH_TIMEOUT_MS);

    await sleep(800);

    if (ASSERT_ZERO_TRUST) {
      const workspaceSafe = safeWorkspaceId(workspaceId);
      const identityPath = path.join(tmpHome, `relay-daemon-identity-${workspaceSafe}.json`);
      const runtimeKeyPath = path.join(tmpHome, `relay-runtime-key-${workspaceSafe}.key`);
      const runtimeKeyExists = await fs
        .access(runtimeKeyPath)
        .then(() => true)
        .catch(() => false);
      if (runtimeKeyExists) {
        throw new Error('Legacy runtime shared key file should not exist');
      }

      const identityRaw = JSON.parse(await fs.readFile(identityPath, 'utf8'));
      if (
        identityRaw?.algorithm !== 'p256' ||
        typeof identityRaw?.publicKey !== 'string' ||
        typeof identityRaw?.privateKey !== 'string'
      ) {
        throw new Error('Daemon identity file invalid shape');
      }
      if (identityRaw.publicKey === identityRaw.privateKey) {
        throw new Error('Daemon identity key material invalid (public == private)');
      }
    }

    log('supersession', 'second daemon connection must be rejected');
    const daemonIssueReset = await post(
      serverUrl,
      `/api/poc/workspaces/${encodeURIComponent(workspaceId)}/reset-daemon-issue-token`,
      {},
      200,
      authHeaders,
    );
    const daemonProbeIssue = await post(serverUrl, '/api/poc/relay-token', {
      role: 'workspace-daemon',
      workspaceId,
      credential: daemonIssueReset.daemonIssueToken,
    });
    await expectWsCloseCode(
      `${relayWsA}?role=workspace-daemon&workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: {
          authorization: `Bearer ${daemonProbeIssue.relayToken}`,
        },
      },
      4008,
      12_000,
    );

    log('policy A', 'trusted_clients_all_workspaces');
    const clientIssueA = await issueClientRelayTokenWithRetry(
      serverUrl,
      workspaceId,
      login.clientAuthToken,
      login.userAuthToken,
      expiryOnly ? 30 : null,
    );
    if (ASSERT_ZERO_TRUST && clientIssueA?.claims?.e2eeKey !== undefined) {
      throw new Error('Server returned forbidden runtime decrypt key in client claims');
    }

    if (expiryOnly) {
      log('expiry', 'relay token must be rejected after expiration');
      const expiryPayload = decodeJwtPayload(clientIssueA.relayToken);
      const issuedAt = Number(expiryPayload.iat);
      const expiresAt = Number(expiryPayload.exp);
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
        throw new Error(
          `invalid relay token expiry payload: ${JSON.stringify({
            iat: expiryPayload.iat,
            exp: expiryPayload.exp,
          })}`,
        );
      }
      const ttlSeconds = Math.floor(expiresAt - issuedAt);
      log('expiry', `observed relay token ttl=${ttlSeconds}s`);
      if (ttlSeconds > 60) {
        throw new Error(
          `expiry scenario expects short-lived relay tokens (<=60s), got ttl=${ttlSeconds}s`,
        );
      }
      const probeWs = await openWs(
        `${relayWsA}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          headers: {
            authorization: `Bearer ${clientIssueA.relayToken}`,
          },
        },
      );
      probeWs.close();
      // JWT exp is second-granularity; add a deterministic buffer beyond token TTL.
      await sleep((ttlSeconds + 2) * 1_000);
      await expectWsOpenRejected(
        `${relayWsA}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          headers: {
            authorization: `Bearer ${clientIssueA.relayToken}`,
          },
        },
        12_000,
      );
      log('pass', 'expiry scenario passed (expired relay JWT rejected)');
      return;
    }

    const tokenHeader = decodeJwtHeader(clientIssueA.relayToken);
    if (tokenHeader.alg !== 'RS256') {
      throw new Error(`Expected RS256 relay token header, got ${JSON.stringify(tokenHeader)}`);
    }
    const jwks = await fetch(`${serverUrl}/api/.well-known/jwks.json`).then((r) => r.json());
    verifyRs256JwtWithJwks(clientIssueA.relayToken, jwks);

    const daemonPublicKey = clientIssueA?.claims?.daemonPublicKey;
    if (typeof daemonPublicKey !== 'string' || daemonPublicKey.length < 80) {
      throw new Error('relay-token response missing daemonPublicKey');
    }

    log('isolation', 'cross-workspace token misuse must be denied');
    const otherWorkspaceId = `${workspaceId}_other`;
    const otherLogin = await post(serverUrl, '/api/poc/users/login', {
      userId: 'user_other',
      clientName: 'other-client',
    });
    const otherHeaders = { authorization: `Bearer ${otherLogin.userAuthToken}` };
    await post(serverUrl, '/api/poc/workspaces/enroll', {
      workspaceId: otherWorkspaceId,
    }, 200, otherHeaders);

    const crossIssue = await post(
      serverUrl,
      '/api/poc/relay-token',
      {
        role: 'client',
        workspaceId: otherWorkspaceId,
        credential: login.clientAuthToken,
      },
      403,
      authHeaders,
    );
    if (crossIssue?.reason !== 'USER_WORKSPACE_MISMATCH') {
      throw new Error(
        `Expected USER_WORKSPACE_MISMATCH for cross-workspace issue, got ${JSON.stringify(crossIssue)}`,
      );
    }

    const crossValidate = await postInternal(serverUrl, '/api/internal/relay/validate', {
      role: 'client',
      workspaceId: otherWorkspaceId,
      relayToken: clientIssueA.relayToken,
    }, 403);
    if (crossValidate?.reason !== 'WORKSPACE_MISMATCH') {
      throw new Error(
        `Expected WORKSPACE_MISMATCH for cross-workspace validation, got ${JSON.stringify(crossValidate)}`,
      );
    }

    await expectWsOpenRejected(
      `${relayWsB}?role=client&workspaceId=${encodeURIComponent(otherWorkspaceId)}`,
      {
        headers: {
          authorization: `Bearer ${clientIssueA.relayToken}`,
        },
      },
    );

    const statePayload = await fetch(`${serverUrl}/api/poc/state`, {
      headers: authHeaders,
    }).then((r) => r.json());
    const stateBlob = JSON.stringify(statePayload);
    if (ASSERT_ZERO_TRUST && (stateBlob.includes('"e2eeKey"') || stateBlob.includes('"e2ee_key"'))) {
      throw new Error('Server state leaked forbidden runtime key fields');
    }

    const clientWsB = await openWs(
      `${relayWsB}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: {
          authorization: `Bearer ${clientIssueA.relayToken}`,
        },
      },
    );
    if (dualRelayMode) {
      const redirectStatus = await waitForRelayStatus(
        clientWsB,
        (msg) => msg.code === 'RELAY_REDIRECT',
        12_000,
      );
      if (redirectStatus.relayWsBaseUrl !== relayWsA) {
        throw new Error(
          `Expected redirect to ${relayWsA}, got ${String(redirectStatus.relayWsBaseUrl)}`,
        );
      }
    } else if (backplaneSingleOnly) {
      await expectNoRelayStatus(
        clientWsB,
        (msg) => msg.code === 'RELAY_REDIRECT',
        1_500,
      );
    }

    const activeProfile = clientIssueA?.claims?.e2eeProfile ?? 'noise-ik';
    const relaySession = await establishRelaySessionViaKeyExchange(
      clientWsB,
      {
        daemonPublicKey,
        profile: activeProfile,
      },
      12_000,
    );
    const relayBuffer = createRelayMessageBuffer(clientWsB, relaySession);
    await requestRelaySyncSnapshotBuffered(clientWsB, relaySession, relayBuffer);

    clientWsB.send(
      JSON.stringify(
        encryptEnvelope(
          relaySession,
          JSON.stringify({
            type: 'list-sessions',
            directoryId: workspaceDirectoryId,
            limit: 5,
            requestId: 'integration-a-1',
          }),
        ),
      ),
    );

    const ackA = await relayBuffer.waitFor(
      (msg) => msg.type === 'ack' && msg.requestId === 'integration-a-1',
      12_000,
    );
    if (ackA.status !== 'ok') {
      throw new Error(`Expected daemon ack ok for list-sessions, got ${JSON.stringify(ackA)}`);
    }

    if (!(loadOnly || soakOnly)) {
      // Explicitly verify plaintext JSON does not get accepted across relay path.
      clientWsB.send(
        JSON.stringify({
          type: 'list-sessions',
          directoryId: workspaceDirectoryId,
          limit: 5,
          requestId: 'integration-a-plain',
        }),
      );
      await expectNoDecryptedMatch(
        clientWsB,
        relaySession,
        (msg) => msg.type === 'ack' && msg.requestId === 'integration-a-plain',
        2_000,
      );

      const tampered = tamperEnvelopeAuthTag(
        encryptEnvelope(
          relaySession,
          JSON.stringify({
            type: 'list-sessions',
            directoryId: workspaceDirectoryId,
            limit: 5,
            requestId: 'integration-a-tampered',
          }),
        ),
      );
      clientWsB.send(JSON.stringify(tampered));

      await expectNoDecryptedMatch(
        clientWsB,
        relaySession,
        (msg) => msg.type === 'ack' && msg.requestId === 'integration-a-tampered',
        2_000,
      );

      clientWsB.send(
        JSON.stringify(
          encryptEnvelope(
            relaySession,
            JSON.stringify({
              type: 'list-sessions',
              directoryId: workspaceDirectoryId,
              limit: 5,
              requestId: 'integration-a-2',
            }),
          ),
        ),
      );
      const ackB = await relayBuffer.waitFor(
        (msg) => msg.type === 'ack' && msg.requestId === 'integration-a-2',
        12_000,
      );
      if (ackB.status !== 'ok') {
        throw new Error(`Expected daemon ack ok after tampered frame, got ${JSON.stringify(ackB)}`);
      }
    }

    if (requestedBackplaneMode === 'server') {
      const busFramesForRelayA = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-a',
        sinceId: 0,
        limit: 200,
        waitMs: 0,
      });
      const busFramesForRelayB = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-b',
        sinceId: 0,
        limit: 200,
        waitMs: 0,
      });
      const allBusFrames = [...(busFramesForRelayA.frames ?? []), ...(busFramesForRelayB.frames ?? [])];
      if (allBusFrames.length === 0) {
        throw new Error('Expected bus frames but found none');
      }
      const keyExchangeResponses = [];
      for (const frame of allBusFrames) {
        if (typeof frame?.payload !== 'string') {
          throw new Error('Bus frame payload is not a string envelope');
        }
        if (frame.payload.includes('integration-a-1') || frame.payload.includes('integration-a-2')) {
          throw new Error('Bus payload leaked plaintext requestId');
        }
        if (frame.payload.includes(workspaceDirectoryId)) {
          throw new Error('Bus payload leaked plaintext directoryId');
        }
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(frame.payload);
        } catch {
          throw new Error('Bus payload was not JSON envelope');
        }
        const isRuntimeEnvelope =
          parsedPayload?.type === 'e2ee' &&
          typeof parsedPayload?.iv === 'string' &&
          typeof parsedPayload?.tag === 'string' &&
          typeof parsedPayload?.ciphertext === 'string';
        const isAllowedControlFrame =
          parsedPayload?.type === 'relay_key_exchange_init' ||
          parsedPayload?.type === 'relay_key_exchange_response' ||
          parsedPayload?.type === 'relay_key_update_required' ||
          parsedPayload?.type === 'relay_status';

        if (!isRuntimeEnvelope && !isAllowedControlFrame) {
          throw new Error(
            `Bus payload unexpected frame type: ${String(parsedPayload?.type ?? 'unknown')}`,
          );
        }
        if (parsedPayload?.type === 'relay_key_exchange_response') {
          keyExchangeResponses.push(parsedPayload);
        }
      }

      if (ASSERT_ZERO_TRUST) {
        if (keyExchangeResponses.length === 0) {
          throw new Error('Expected at least one relay_key_exchange_response frame in bus');
        }
        for (const responseFrame of keyExchangeResponses) {
          if (
            rogueCanValidateSessionProof(
              responseFrame,
              daemonPublicKey,
              relaySession.initFrame,
              undefined,
            )
          ) {
            throw new Error('Rogue actor was able to validate daemon proof without client private key');
          }
        }
      }
    }
    if (backplaneSingleOnly) {
      const busFramesForRelayA = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-a',
        sinceId: 0,
        limit: 50,
        waitMs: 0,
      });
      if (Array.isArray(busFramesForRelayA.frames) && busFramesForRelayA.frames.length > 0) {
        throw new Error(
          `single backplane should not emit bus frames, got ${busFramesForRelayA.frames.length}`,
        );
      }
    }
    if (backplaneRedisOnly) {
      const busFramesForRelayA = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-a',
        sinceId: 0,
        limit: 50,
        waitMs: 0,
      });
      const busFramesForRelayB = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-b',
        sinceId: 0,
        limit: 50,
        waitMs: 0,
      });
      if ((busFramesForRelayA.frames ?? []).length > 0 || (busFramesForRelayB.frames ?? []).length > 0) {
        throw new Error('redis backplane should not write relay bus frames through server');
      }
    }

    if (smokeOnly || backplaneSingleOnly || backplaneServerOnly || backplaneRedisOnly) {
      clientWsB.close();
      if (backplaneSingleOnly) {
        log('pass', 'single backplane flow passed (single-relay encrypted daemon ack path)');
      } else if (backplaneRedisOnly) {
        log('pass', 'redis backplane flow passed (dual-relay redirect and redis queue path)');
      } else if (backplaneServerOnly) {
        log('pass', 'server backplane flow passed (dual-relay redirect and bus path)');
      } else {
        log('pass', 'smoke flow passed (dual-relay encrypted daemon ack path)');
      }
      return;
    }

    if (loadOnly) {
      clientWsB.close();
      await runLoadScenario({
        serverUrl,
        relayWsBase: relayWsB,
        workspaceId,
        workspaceDirectoryId,
        userId: 'user_demo',
        userAuthToken: login.userAuthToken,
        daemonPublicKey,
        profile: activeProfile,
      });
      log('pass', 'load scenario passed');
      return;
    }

    if (soakOnly) {
      await runSoakScenario({
        ws: clientWsB,
        session: relaySession,
        buffer: relayBuffer,
        daemonPublicKey,
        profile: activeProfile,
      });
      relayBuffer.close();
      clientWsB.close();
      log('pass', 'soak scenario passed');
      return;
    }

    if (chaosOnly) {
      await runChaosScenario({
        relayProcB,
        ws: clientWsB,
        serverUrl,
        relayWsBase: relayWsA,
        workspaceId,
        workspaceDirectoryId,
        clientAuthToken: login.clientAuthToken,
        userAuthToken: login.userAuthToken,
        daemonPublicKey,
        profile: activeProfile,
      });
      log('pass', 'chaos scenario passed');
      return;
    }

    if (replayOnly) {
      relayProcB = await runReplayScenario({
        daemonPort,
        serverUrl,
        relayWsBase: relayWsB,
        relayPort: relay2Port,
        relayProc: relayProcB,
        procs,
        workspaceId,
        clientAuthToken: login.clientAuthToken,
        userAuthToken: login.userAuthToken,
        daemonPublicKey,
        profile: activeProfile,
        relayEnv: relayBEnv,
      });
      clientWsB.close();
      log('pass', 'replay scenario passed');
      return;
    }

    clientWsB.close();

    log('policy B', 'allowlist deny then allow');
    await post(serverUrl, `/api/poc/workspaces/${encodeURIComponent(workspaceId)}/policy`, {
      policyMode: 'trusted_clients_allowlist',
      allowlistClientIds: [],
    }, 200, authHeaders);

    await post(
      serverUrl,
      '/api/poc/relay-token',
      {
        role: 'client',
        workspaceId,
        credential: login.clientAuthToken,
      },
      403,
      authHeaders,
    );

    await post(serverUrl, `/api/poc/workspaces/${encodeURIComponent(workspaceId)}/policy`, {
      policyMode: 'trusted_clients_allowlist',
      allowlistClientIds: [login.clientId],
    }, 200, authHeaders);

    const policyBIssue = await post(serverUrl, '/api/poc/relay-token', {
      role: 'client',
      workspaceId,
      credential: login.clientAuthToken,
    }, 200, authHeaders);
    if (policyBIssue?.claims?.e2eeProfile !== 'noise-ik') {
      throw new Error(`Expected policy B profile noise-ik, got ${String(policyBIssue?.claims?.e2eeProfile)}`);
    }

    log('policy C', 'explicit pairing required');
    await post(serverUrl, `/api/poc/workspaces/${encodeURIComponent(workspaceId)}/policy`, {
      policyMode: 'explicit_pairing_required',
    }, 200, authHeaders);

    await post(
      serverUrl,
      '/api/poc/relay-token',
      {
        role: 'client',
        workspaceId,
        credential: login.clientAuthToken,
      },
      403,
      authHeaders,
    );

    const remotePairing = await pairClientOverRelay({
      serverUrl,
      relayWsBase: relayWsB,
      workspaceId,
      clientId: login.clientId,
      clientAuthToken: login.clientAuthToken,
      userAuthToken: login.userAuthToken,
    });

    if (dualRelayMode) {
      const pairBusA = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-a',
        sinceId: 0,
        limit: 200,
        waitMs: 0,
      });
      const pairBusB = await postInternal(serverUrl, '/api/internal/relay/bus/pull', {
        relayId: 'relay-b',
        sinceId: 0,
        limit: 200,
        waitMs: 0,
      });
      const pairBusBlob = JSON.stringify([...(pairBusA.frames ?? []), ...(pairBusB.frames ?? [])]);
      for (const marker of [
        remotePairing.sensitiveMarkers.redeemSecret,
        remotePairing.sensitiveMarkers.trustAnchor,
      ]) {
        if (typeof marker === 'string' && marker.length > 0 && pairBusBlob.includes(marker)) {
          throw new Error('Bus payload leaked plaintext pairing bootstrap material');
        }
      }
    }

    const policyCIssue = await post(serverUrl, '/api/poc/relay-token', {
      role: 'client',
      workspaceId,
      credential: login.clientAuthToken,
    }, 200, authHeaders);
    if (policyCIssue?.claims?.e2eeProfile !== 'noise-ikpsk2') {
      throw new Error(
        `Expected policy C profile noise-ikpsk2, got ${String(policyCIssue?.claims?.e2eeProfile)}`,
      );
    }
    if (policyCIssue?.claims?.pairingSecret !== null) {
      throw new Error('Policy C relay token must not include pairingSecret claim');
    }

    let policyCWs = null;
    let policyCSession = null;
    let lastPolicyCError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ws = await openWs(
        `${relayWsB}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          headers: {
            authorization: `Bearer ${policyCIssue.relayToken}`,
          },
        },
      );
      try {
        const session = await establishRelaySessionViaKeyExchange(
          ws,
          {
            daemonPublicKey: remotePairing.daemonPublicKey,
            profile: 'noise-ikpsk2',
            pairingPeerId: remotePairing.pairingPeerId,
            pairingSecret: remotePairing.pairingSecret,
          },
          12_000,
        );
        policyCWs = ws;
        policyCSession = session;
        break;
      } catch (error) {
        lastPolicyCError = error;
        ws.close();
        await sleep(1_250);
      }
    }
    if (!policyCWs || !policyCSession) {
      throw new Error(
        `Policy C key exchange failed after retries: ${lastPolicyCError instanceof Error ? lastPolicyCError.message : String(lastPolicyCError)}`,
      );
    }
    const policyCBuffer = createRelayMessageBuffer(policyCWs, policyCSession);
    await requestRelaySyncSnapshotBuffered(policyCWs, policyCSession, policyCBuffer);
    policyCWs.send(
      JSON.stringify(
        encryptEnvelope(
          policyCSession,
          JSON.stringify({
            type: 'list-sessions',
            directoryId: workspaceDirectoryId,
            limit: 3,
            requestId: 'policy-c-1',
          }),
        ),
      ),
    );
    const policyCAck = await policyCBuffer.waitFor(
      (msg) => msg.type === 'ack' && msg.requestId === 'policy-c-1',
      12_000,
    );
    policyCBuffer.close();
    policyCWs.close();
    if (policyCAck.status !== 'ok') {
      throw new Error(`Policy C encrypted relay request failed: ${JSON.stringify(policyCAck)}`);
    }

    log('revocation', 'client revoke must block access');
    await post(
      serverUrl,
      `/api/poc/clients/${encodeURIComponent(login.clientId)}/revoke`,
      {},
      200,
      authHeaders,
    );
    await post(
      serverUrl,
      '/api/poc/relay-token',
      {
        role: 'client',
        workspaceId,
        credential: login.clientAuthToken,
      },
      403,
      authHeaders,
    );

    const relayLogs = await fetch(`http://127.0.0.1:${relayPort}/logs`, {
      headers: {
        authorization: `Bearer ${RELAY_ADMIN_TOKEN}`,
      },
    }).then((r) => r.json());
    const logsBlob = JSON.stringify(relayLogs);
    if (logsBlob.includes('integration-a-1') || logsBlob.includes(workspaceDirectoryId)) {
      throw new Error('Relay logs leaked plaintext payload content');
    }
    for (const marker of [
      remotePairing.sensitiveMarkers.redeemSecret,
      remotePairing.sensitiveMarkers.trustAnchor,
    ]) {
      if (typeof marker === 'string' && marker.length > 0 && logsBlob.includes(marker)) {
        throw new Error('Relay logs leaked plaintext pairing bootstrap material');
      }
    }

    log(
      'pass',
      'full e2e flow passed (server+dual-relay redirect+bus forwarding+daemon native runtime, policy A/B/C, encrypted transport)',
    );
  } finally {
    for (const proc of [...procs].reverse()) {
      proc.kill('SIGTERM');
    }
    await sleep(700);
    for (const proc of [...procs].reverse()) {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }
    await Promise.all(
      procs.map(
        (proc) =>
          new Promise((resolve) => {
            if (proc.exitCode !== null) {
              resolve(undefined);
              return;
            }
            const timeout = setTimeout(() => resolve(undefined), 2_000);
            proc.once('exit', () => {
              clearTimeout(timeout);
              resolve(undefined);
            });
          }),
      ),
    );
    for (const proc of procs) {
      proc.removeAllListeners();
    }
    await redisServer?.stop();
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

async function findAvailablePort(startPort, reservedPorts, attempts = 24) {
  for (let offset = 0; offset < attempts; offset++) {
    const port = startPort + offset;
    if (reservedPorts.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) {
      reservedPorts.add(port);
      return port;
    }
  }

  throw new Error(`Unable to find available port starting at ${startPort}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[integration] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
