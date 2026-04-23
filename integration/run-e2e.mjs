import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const INTEGRATION_SCENARIO = (process.env.INTEGRATION_SCENARIO || 'operator').toLowerCase();
const REQUESTED_SERVER_PORT = Number(process.env.SERVER_PORT || 7780);
const REQUESTED_RELAY_PORT = Number(process.env.RELAY_PORT || 7781);
const REQUESTED_DAEMON_PORT = Number(process.env.DAEMON_PORT || 7790);
const RELAY_ADMIN_TOKEN =
  process.env.RELAY_ADMIN_TOKEN || 'integration-relay-admin-token';
const RELAY_INTERNAL_KEY =
  process.env.RELAY_INTERNAL_KEY || 'integration-relay-internal-key';

function resolveExistingDir(...candidates) {
  for (const candidate of candidates) {
    try {
      if (fsSync.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(`Unable to resolve directory from candidates: ${candidates.join(', ')}`);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_ROOT = path.resolve(ROOT, '..');
const PLATFORM_ROOT = process.env.PLATFORM_ROOT
  ? path.resolve(process.env.PLATFORM_ROOT)
  : resolveExistingDir(
      path.join(ROOT, 'platform'),
      path.join(LEGACY_ROOT, 'platform'),
    );

const SERVER_DIR = resolveExistingDir(
  path.join(PLATFORM_ROOT, 'apps', 'api'),
  path.join(ROOT, 'server'),
  path.join(LEGACY_ROOT, 'platform', 'apps', 'api'),
);
const RELAY_DIR = resolveExistingDir(
  path.join(ROOT, 'services', 'relay'),
  path.join(ROOT, 'relay'),
);
const DAEMON_DIR = resolveExistingDir(
  path.join(ROOT, 'packages', 'daemon'),
  path.join(ROOT, 'daemon'),
);

function log(step, details = '') {
  process.stdout.write(`[integration] ${step}${details ? ` ${details}` : ''}\n`);
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
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function runCommand(cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${code}`);
  }
}

async function runJsonCommand(cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return parseJsonFromStdout(stdout, `${cmd} ${args.join(' ')}`);
}

function parseJsonFromStdout(stdout, commandLabel) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });

  if (!jsonLine) {
    throw new Error(`Expected JSON output from ${commandLabel}, got:\n${stdout}`);
  }

  return JSON.parse(jsonLine);
}

function encodeEnvValue(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(stringValue)) {
    return stringValue;
  }

  return JSON.stringify(stringValue);
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function httpJson(baseUrl, pathname, options = {}, expectedStatuses = [200]) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const json = await response.json().catch(() => ({}));
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `${options.method || 'GET'} ${pathname} expected ${expectedStatuses.join('/')} got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
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
    return `${key}=${encodeEnvValue(values[key])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      updated.push(`${key}=${encodeEnvValue(value)}`);
    }
  }

  await fs.writeFile(filePath, `${updated.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
}

function waitForPort(host, requestedPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function findAvailablePort(startPort, reservedPorts) {
  let candidate = Math.max(1025, startPort);
  while (reservedPorts.has(candidate)) candidate += 1;
  for (let attempt = 0; attempt < 200; attempt += 1, candidate += 1) {
    if (reservedPorts.has(candidate)) continue;
    try {
      const port = await waitForPort('127.0.0.1', candidate);
      reservedPorts.add(port);
      return port;
    } catch {
      // Try next port.
    }
  }
  throw new Error(`Unable to reserve port starting from ${startPort}`);
}

async function openWs(url, options = {}, timeoutMs = 10_000) {
  const ws = new WebSocket(url, options);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WS open timeout: ${url}`)), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return ws;
}

async function seedOperatorFixture(serverUrl) {
  const json = await runJsonCommand(
    PHP_BIN,
    ['artisan', 'viewport:seed-operator-integration-fixture', '--json'],
    SERVER_DIR,
    {
      APP_URL: serverUrl,
    },
  );

  if (!json?.user?.email || !json?.workspace?.id) {
    throw new Error(`Unexpected operator integration fixture payload: ${JSON.stringify(json)}`);
  }

  return json;
}

async function waitForPairingClaim(serverUrl, code) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const json = await httpJson(serverUrl, `/api/pairing-codes/${encodeURIComponent(code)}/status`);
    if (json?.status === 'claimed') return json;
    if (json?.status === 'denied' || json?.status === 'expired') {
      throw new Error(`Pairing code entered terminal state before approval: ${JSON.stringify(json)}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for pairing code ${code} to be claimed`);
}

async function waitForDaemonReady(daemonUrl) {
  await waitForHealth(`${daemonUrl}/health`, 45_000);
}

async function waitForRelayPresence(serverUrl, workspaceId, relayHttpUrl) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const resolved = await httpJson(
      serverUrl,
      '/api/runtime/internal/relay/presence/resolve',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-relay-internal-key': RELAY_INTERNAL_KEY,
        },
        body: JSON.stringify({ workspaceId }),
      },
    );

    const relayState = await httpJson(relayHttpUrl, '/state', {
      headers: {
        authorization: `Bearer ${RELAY_ADMIN_TOKEN}`,
      },
    });

    const relayWorkspace = Array.isArray(relayState?.workspaces)
      ? relayState.workspaces.find((item) => item.workspaceId === workspaceId)
      : null;

    if (resolved?.daemonConnected === true && relayWorkspace?.daemonConnected === true) {
      return {
        resolvePayload: resolved,
        relayWorkspace,
      };
    }

    await sleep(500);
  }
  throw new Error(`Timed out waiting for relay presence for workspace ${workspaceId}`);
}

async function stopDaemon(env) {
  try {
    await runJsonCommand('node', ['dist/index.js', 'stop', '--json'], DAEMON_DIR, env);
  } catch {
    // Best effort during cleanup.
  }
}

async function main() {
  if (!['operator', 'e2e'].includes(INTEGRATION_SCENARIO)) {
    throw new Error(
      `Unsupported INTEGRATION_SCENARIO=${INTEGRATION_SCENARIO}. This harness currently supports operator|e2e.`,
    );
  }

  const reservedPorts = new Set();
  const serverPort = await findAvailablePort(REQUESTED_SERVER_PORT, reservedPorts);
  const relayPort = await findAvailablePort(REQUESTED_RELAY_PORT, reservedPorts);
  const daemonPort = await findAvailablePort(REQUESTED_DAEMON_PORT, reservedPorts);

  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const relayHttpUrl = `http://127.0.0.1:${relayPort}`;
  const relayWsUrl = `ws://127.0.0.1:${relayPort}/ws`;
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const daemonHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-integration-home-'));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-integration-project-'));

  const daemonEnv = {
    VIEWPORT_HOME: daemonHome,
    VIEWPORT_LISTEN: `127.0.0.1:${daemonPort}`,
    VIEWPORT_AUTH: '0',
    VIEWPORT_TLS: '0',
    VIEWPORT_ALLOWED_HOSTS: '127.0.0.1,localhost',
    VIEWPORT_ALLOWED_ORIGINS: '127.0.0.1,localhost',
    VIEWPORT_RELAY_TLS_VERIFY: '0',
  };

  const serverEnvValues = {
    APP_ENV: 'local',
    APP_URL: serverUrl,
    SPA_URL: serverUrl,
    RELAY_WS_URL: relayWsUrl,
    VIEWPORT_RELAY_HTTP_URL: relayHttpUrl,
    VIEWPORT_RELAY_INTERNAL_KEY: RELAY_INTERNAL_KEY,
    VIEWPORT_RELAY_ADMIN_TOKEN: RELAY_ADMIN_TOKEN,
    VIEWPORT_RELAY_VERIFY_TLS: '0',
    VIEWPORT_RELAY_INTERNAL_ALLOW_LOOPBACK_LOCAL: '1',
  };

  const procs = [];
  let daemonStopped = false;

  try {
    log('ports', `server=${serverPort} relay=${relayPort} daemon=${daemonPort}`);

    await upsertEnvFile(
      path.join(SERVER_DIR, '.env'),
      serverEnvValues,
      path.join(SERVER_DIR, '.env.example'),
    );

    log('api', 'migrate fresh');
    await runCommand(PHP_BIN, ['artisan', 'migrate:fresh', '--force'], SERVER_DIR);
    await runCommand(PHP_BIN, ['artisan', 'config:clear'], SERVER_DIR);

    log('api', 'start');
    const serverProc = spawnProc(
      'server',
      PHP_BIN,
      ['artisan', 'serve', '--host=127.0.0.1', `--port=${serverPort}`],
      SERVER_DIR,
      serverEnvValues,
    );
    procs.push(serverProc);
    await waitForHealth(`${serverUrl}/api/health`, 45_000);

    const fixture = await seedOperatorFixture(serverUrl);
    const workspaceId = fixture.workspace.id;
    const operatorToken = fixture.token;
    if (!operatorToken) {
      throw new Error(`Operator integration fixture did not return a token: ${JSON.stringify(fixture)}`);
    }

    log('relay', 'build');
    await runCommand('npm', ['run', 'build'], RELAY_DIR);
    log('daemon', 'build');
    await runCommand('npm', ['run', 'build'], DAEMON_DIR);

    log('relay', 'start');
    const relayProc = spawnProc(
      'relay',
      'node',
      ['dist/index.js'],
      RELAY_DIR,
      {
        PORT: String(relayPort),
        HOST: '127.0.0.1',
        SERVER_URL: serverUrl,
        RELAY_PUBLIC_WS_BASE_URL: relayWsUrl,
        RELAY_MODE: 'dev',
        RELAY_TLS: '0',
        RELAY_ENABLE_ADMIN_HTTP: '1',
        RELAY_ADMIN_TOKEN: RELAY_ADMIN_TOKEN,
        RELAY_INTERNAL_KEY: RELAY_INTERNAL_KEY,
      },
    );
    procs.push(relayProc);
    await waitForHealth(`${relayHttpUrl}/health`, 45_000);

    log('pair', 'issue web pairing code');
    const pairingCode = await httpJson(
      serverUrl,
      `/api/workspaces/${encodeURIComponent(workspaceId)}/pairing-codes`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      [201],
    );

    if (!pairingCode?.code) {
      throw new Error(`Pairing code response missing code: ${JSON.stringify(pairingCode)}`);
    }

    log('pair', `claim ${pairingCode.code}`);
    const pairProc = spawn(
      'node',
      ['dist/index.js', 'pair', pairingCode.code, '--server', serverUrl, '--json'],
      {
        cwd: DAEMON_DIR,
        env: { ...process.env, ...daemonEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let pairStdout = '';
    let pairStderr = '';
    pairProc.stdout.on('data', (chunk) => {
      pairStdout += chunk.toString('utf8');
    });
    pairProc.stderr.on('data', (chunk) => {
      pairStderr += chunk.toString('utf8');
    });

    const claimed = await waitForPairingClaim(serverUrl, pairingCode.code);
    if (!claimed?.daemon_name) {
      throw new Error(`Pairing claim missing daemon_name: ${JSON.stringify(claimed)}`);
    }

    log('pair', 'approve');
    await httpJson(
      serverUrl,
      `/api/pairing-codes/${encodeURIComponent(pairingCode.code)}/approve`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );

    const pairExitCode = await new Promise((resolve) => pairProc.once('exit', resolve));
    if (pairExitCode !== 0) {
      throw new Error(`vpd pair failed with code ${pairExitCode}\nstdout:\n${pairStdout}\nstderr:\n${pairStderr}`);
    }

    const pairResult = parseJsonFromStdout(pairStdout, 'vpd pair');
    if (pairResult?.ok !== true) {
      throw new Error(`Unexpected vpd pair result: ${JSON.stringify(pairResult)}`);
    }

    log('daemon', 'wait for health');
    await waitForDaemonReady(daemonUrl);

    log('relay', 'wait for workspace presence');
    const presence = await waitForRelayPresence(serverUrl, workspaceId, relayHttpUrl);

    log('api', 'verify install list');
    const installs = await httpJson(
      serverUrl,
      `/api/workspaces/${encodeURIComponent(workspaceId)}/installs`,
      {
        headers: {
          authorization: `Bearer ${operatorToken}`,
        },
      },
    );
    const installRows = Array.isArray(installs?.data) ? installs.data : [];
    const claimedInstall = installRows.find((install) => install.name === claimed.daemon_name);
    if (!claimedInstall) {
      throw new Error(`Could not find paired install for ${claimed.daemon_name}`);
    }

    log('daemon', 'register local directory');
    await fs.writeFile(path.join(projectDir, 'README.md'), '# viewport operator integration\n', 'utf8');
    const createdDirectory = await httpJson(
      daemonUrl,
      '/api/directories',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ path: projectDir }),
      },
      [201],
    );
    if (!createdDirectory?.id) {
      throw new Error(`Directory registration failed: ${JSON.stringify(createdDirectory)}`);
    }

    log('api', 'issue browser relay token');
    const browserRelayToken = await httpJson(
      serverUrl,
      `/api/workspaces/${encodeURIComponent(workspaceId)}/relay-token`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    if (!browserRelayToken?.token) {
      throw new Error(`Browser relay token response missing token: ${JSON.stringify(browserRelayToken)}`);
    }

    log('api', 'validate browser relay token');
    const validated = await httpJson(
      serverUrl,
      '/api/runtime/internal/relay/validate',
      {
        method: 'POST',
        headers: {
          'x-relay-internal-key': RELAY_INTERNAL_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          relayToken: browserRelayToken.token,
          role: 'client',
          workspaceId,
        }),
      },
    );
    if (validated?.ok !== true) {
      throw new Error(`Runtime validate failed: ${JSON.stringify(validated)}`);
    }

    log('relay', 'open browser websocket');
    const clientWs = await openWs(
      `${relayWsUrl}?role=client&workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: {
          authorization: `Bearer ${browserRelayToken.token}`,
        },
      },
      10_000,
    );
    clientWs.close();

    if (INTEGRATION_SCENARIO === 'e2e') {
      log('daemon', 'verify local directory list');
      const directoryList = await httpJson(daemonUrl, '/api/directories');
      const hasDirectory = Array.isArray(directoryList)
        ? directoryList.some((directory) => directory.id === createdDirectory.id)
        : false;
      if (!hasDirectory) {
        throw new Error(`Registered directory missing from daemon list: ${JSON.stringify(directoryList)}`);
      }
    }

    const summary = {
      scenario: INTEGRATION_SCENARIO,
      ok: true,
      serverUrl,
      relayWsUrl,
      daemonUrl,
      workspaceId,
      installId: claimedInstall.id,
      claimedDaemonName: claimed.daemon_name,
      relayPresence: presence.resolvePayload,
    };

    log('pass', JSON.stringify(summary));
  } finally {
    if (!daemonStopped) {
      await stopDaemon(daemonEnv);
      daemonStopped = true;
    }

    for (const proc of procs.reverse()) {
      proc.kill('SIGTERM');
      await waitForProcessExit(proc, 5_000).catch(() => {
        proc.kill('SIGKILL');
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
