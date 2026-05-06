const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { PlaygroundState, PlaygroundPlatform, DEFAULT_REPO } = require('./state');

const root = path.resolve(process.env.VAULT_PLAYGROUND_HOME || '.playground');
const publicDir = path.resolve(__dirname, '../../playground');
const port = Number(process.env.PORT || 8787);
const state = new PlaygroundState(root);
const platform = state.platform;

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(publicDir, pathname));
  if (!file.startsWith(publicDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(file);
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  fs.createReadStream(file).pipe(res);
}

const handlers = [
  // ── State ──────────────────────────────────────────────
  ['GET', /^\/api\/state$/, async () => state.snapshot()],
  ['GET', /^\/api\/timeline$/, async () => state.getTimeline()],
  ['GET', /^\/api\/scan\/plaintext$/, async () => state.scanPlaintext()],
  ['GET', /^\/api\/scan\/no-leak$/, async () => platform.scanForPrivateKeyMaterial()],
  ['GET', /^\/api\/keys\/fingerprints$/, async () => {
    const out = {};
    for (const [name, vault] of platform.devices) {
      try {
        const id = vault.getIdentity(name);
        out[name] = {
          kind: 'device',
          signing: id?.signingPublicKey || id?.publicKey,
          hpke: id?.hpkePublicKey,
        };
      } catch {}
    }
    for (const [name] of platform.users) {
      try {
        const owner = platform.userOwnerVault(name);
        const id = owner.getKnownIdentity(name);
        out[name] = {
          kind: 'user',
          signing: id?.signingPublicKey || id?.publicKey,
          hpke: id?.hpkePublicKey,
        };
      } catch {}
    }
    return out;
  }],

  // ── Sync envelopes / events (legacy and new) ───────────
  ['GET', /^\/api\/sync\/events$/, async () => state.listSyncEvents()],
  ['GET', /^\/api\/sync\/events\/(.+)$/, async (_, m) => state.getSyncEvent(decodeURIComponent(m[1]))],
  ['GET', /^\/api\/repos\/([^/]+)\/events$/, async (_, m) => {
    const repoId = m[1];
    const repo = platform.repos.get(repoId);
    if (!repo) throw new Error(`Unknown repo: ${repoId}`);
    return platform.listRepoEvents(repoId, repo.ownerDevice);
  }],
  ['GET', /^\/api\/repos\/([^/]+)\/events\/(.+)$/, async (_, m) => {
    const repoId = m[1];
    const eventId = decodeURIComponent(m[2]);
    const repo = platform.repos.get(repoId);
    if (!repo) throw new Error(`Unknown repo: ${repoId}`);
    return platform.getRepoEvent(repoId, repo.ownerDevice, eventId);
  }],
  ['GET', /^\/api\/sync\/mailboxes$/, async () => {
    const out = {};
    for (const [deviceName] of platform.devices) {
      const dir = platform.mailbox(deviceName);
      try {
        out[deviceName] = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch { out[deviceName] = []; }
    }
    return out;
  }],

  // ── Reset ──────────────────────────────────────────────
  ['POST', /^\/api\/reset$/, async (req, _, url) => {
    const mode = url.searchParams.get('mode') || 'with-bob';
    return state.reset(mode);
  }],

  // ── Users ──────────────────────────────────────────────
  ['POST', /^\/api\/users$/, async (req) => {
    const body = await readBody(req);
    await platform.bootstrapUser({
      userName: body.userName,
      passphrase: body.passphrase || `${body.userName}-passphrase`,
      recoveryCode: body.recoveryCode || `${body.userName}-recovery`,
      primaryDeviceName: body.primaryDeviceName || `${body.userName}-laptop`,
    });
    return { snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/users\/([^/]+)\/devices$/, async (req, m) => {
    const userName = m[1];
    const body = await readBody(req);
    const result = await platform.addDevice({
      userName, deviceName: body.deviceName, code: body.code,
      approverDeviceName: body.approverDeviceName,
    });
    return { ...result, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/users\/([^/]+)\/recover$/, async (req, m) => {
    const userName = m[1];
    const body = await readBody(req);
    const u = platform.users.get(userName);
    if (!u) throw new Error(`Unknown user: ${userName}`);
    const passphrase = body.passphrase ?? u.passphrase;
    const recoveryCode = body.recoveryCode ?? u.recoveryCode;
    try {
      const id = platform.device(u.primaryDevice).recoverUserIdentity({
        userName, passphrase, recoveryCode,
      });
      return {
        ok: true,
        userName,
        encryptionPublicKey: id?.encryptionPublicKey,
        hpkePublicKey: id?.hpkePublicKey,
        signingPublicKey: id?.signingPublicKey || id?.publicKey,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }],
  ['POST', /^\/api\/users\/([^/]+)\/rotate$/, async (req, m) => {
    const userName = m[1];
    await platform.rotateUser({ userName });
    return { snapshot: await state.snapshot() };
  }],

  // ── Repos / members / grants ───────────────────────────
  ['POST', /^\/api\/repos$/, async (req) => {
    const body = await readBody(req);
    await platform.createRepo({
      repoId: body.repoId || DEFAULT_REPO,
      ownerUserName: body.ownerUserName,
      ownerDeviceName: body.ownerDeviceName,
    });
    return { snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/members$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const member = await platform.addMember({ repoId, userName: body.userName, history: body.history || 'full' });
    return { member, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/grants$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    await platform.peerGrant({
      repoId, granterDevice: body.granterDevice,
      recipientUserName: body.recipientUserName,
    });
    return { snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/revoke$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const newEpoch = await platform.revokeMember({
      repoId, granterDevice: body.granterDevice,
      recipientUserName: body.recipientUserName,
    });
    return { newEpoch, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/entries$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const event = await platform.addEntry({
      repoId, actorDevice: body.actorDevice,
      scope: body.scope, title: body.title, body: body.body, source: body.source,
    });
    return { event, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/candidates$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const event = await platform.proposeCandidate({
      repoId, actorDevice: body.actorDevice,
      title: body.title, body: body.body, source: body.source,
    });
    return { event, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/candidates\/approve$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const event = await platform.approveFirstCandidate({
      repoId, actorDevice: body.actorDevice || 'alice-laptop',
      replacementBody: body.replacementBody,
    });
    return { event, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/sync$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const result = await platform.sync({
      repoId, fromDevice: body.fromDevice,
      toDevices: body.toDevices,
    });
    return { ...result, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/repos\/([^/]+)\/search$/, async (req, m) => {
    const repoId = m[1];
    const body = await readBody(req);
    const vault = platform.device(body.actorDevice);
    return vault.search({ repoId, actorName: body.actorDevice, query: body.query });
  }],
  ['GET', /^\/api\/repos\/([^/]+)\/access$/, async (_, m, url) => {
    const repoId = m[1];
    const userName = url.searchParams.get('userName');
    const deviceName = url.searchParams.get('deviceName');
    const peerDevice = url.searchParams.get('peerDevice') || platform.repos.get(repoId)?.ownerDevice;
    const access = platform.accessFor(repoId, peerDevice);
    return access.accessDecision({ userName, deviceName });
  }],
  ['GET', /^\/api\/repos\/([^/]+)\/bundle$/, async (_, m, url) => {
    const repoId = m[1];
    const deviceName = url.searchParams.get('deviceName');
    const includePrivate = url.searchParams.get('includePrivate') !== 'false';
    const vault = platform.device(deviceName);
    return vault.resolveBundle({
      repoId, actorName: deviceName,
      packs: ['pr-readiness', 'testing-policy'],
      target: { type: 'pull_request', ref: '123' },
      includePrivate,
    });
  }],

  // ── Legacy compatibility ───────────────────────────────
  ['POST', /^\/api\/sync$/, async () => {
    const result = await state.syncToBob();
    return { ...result, snapshot: await state.snapshot() };
  }],
  ['POST', /^\/api\/grant$/, async () => state.grantBob()],
  ['POST', /^\/api\/revoke$/, async () => state.revokeBobAndAddEntry()],
  ['POST', /^\/api\/revoke\/only$/, async () => state.revokeBob()],
  ['POST', /^\/api\/approve-candidate$/, async () => state.approveFirstCandidate()],
  ['POST', /^\/api\/bundle\/alice$/, async () => state.resolveBundle('alice', true)],
  ['POST', /^\/api\/bundle\/bob$/, async () => state.resolveBundle('bob', true)],
  ['POST', /^\/api\/bundle\/compare$/, async () => state.compareBundles()],
  ['POST', /^\/api\/entry$/, async (req) => {
    const body = await readBody(req);
    return state.addEntry(body);
  }],
  ['POST', /^\/api\/candidate$/, async (req) => {
    const body = await readBody(req);
    return state.proposeEntry(body);
  }],
  ['POST', /^\/api\/search$/, async (req) => {
    const body = await readBody(req);
    return state.search(body.actorName || 'alice', body.query || '');
  }],
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    for (const [method, pattern, handler] of handlers) {
      if (req.method !== method) continue;
      const match = url.pathname.match(pattern);
      if (!match) continue;
      const result = await handler(req, match, url);
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined });
  }
});

server.listen(port, '127.0.0.1', async () => {
  await state.reset('with-bob');
  process.stdout.write(`Context Vault playground: http://127.0.0.1:${port}\n`);
});
