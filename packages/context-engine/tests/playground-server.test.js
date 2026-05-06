const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { test } = require('node:test');
const path = require('node:path');
const { tempHome } = require('./helpers');

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('Context Vault playground')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      reject(new Error(`Server exited before ready: ${code}. Output: ${output}`));
    });
  });
}

async function request(port, route, body = null) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.equal(response.ok, true, payload.error);
  return payload;
}

test('playground server exposes the real vault flow over HTTP', async (t) => {
  const port = 9787;
  const home = tempHome('vault-playground-http');
  const child = childProcess.spawn('node', ['src/playground/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), VAULT_PLAYGROUND_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitForServer(child);

  let state = await request(port, '/api/state');
  assert.equal(state.checks.every((check) => check.pass), true);
  assert.equal(state.alice.entries.some((entry) => entry.scope === 'private'), true);
  assert.equal(state.bob.entries.some((entry) => entry.scope === 'private'), false);

  await request(port, '/api/entry', {
    scope: 'project',
    title: 'Release checklist',
    body: 'Release work must include rollback notes.',
    source: 'manual://playground',
  });
  await request(port, '/api/sync', {});
  const bobSearch = await request(port, '/api/search', {
    actorName: 'bob',
    query: 'rollback notes',
  });
  assert.equal(bobSearch.length, 1);

  await request(port, '/api/revoke', {});
  await request(port, '/api/sync', {});
  const postRevoke = await request(port, '/api/search', {
    actorName: 'bob',
    query: 'Post-revocation',
  });
  assert.equal(postRevoke.length, 0);
});
