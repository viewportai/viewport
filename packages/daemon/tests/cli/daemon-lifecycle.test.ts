import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  clearDaemonRuntimeState,
  isPidRunning,
  isOwnershipMatch,
  readDaemonRuntimeState,
  stopPid,
  writeDaemonRuntimeState,
} from '../../src/cli/daemon-lifecycle.js';

describe('daemon lifecycle helpers', () => {
  let tempHome: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-daemon-lifecycle-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('writes and reads daemon runtime state', async () => {
    await writeDaemonRuntimeState({
      pid: 1234,
      port: 7070,
      host: '127.0.0.1',
      startedAt: Date.now(),
      version: '0.1.0',
    });

    const statePath = path.join(tempHome, '.viewport', 'daemon-state.json');
    const stat = await fs.stat(statePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const state = await readDaemonRuntimeState();
    expect(state?.pid).toBe(1234);
    expect(state?.port).toBe(7070);
    expect(state?.host).toBe('127.0.0.1');
  });

  it('clears daemon runtime state', async () => {
    await writeDaemonRuntimeState({
      pid: 1234,
      port: 7070,
      host: '127.0.0.1',
      startedAt: Date.now(),
      version: '0.1.0',
    });

    await clearDaemonRuntimeState();
    const state = await readDaemonRuntimeState();
    expect(state).toBeNull();
  });

  it('detects running process ids', () => {
    expect(isPidRunning(process.pid)).toBe(true);
  });

  it('stops a running pid with SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;
    expect(isPidRunning(pid)).toBe(true);

    const result = await stopPid(pid, 3000);
    expect(result).toBe('stopped');
    expect(isPidRunning(pid)).toBe(false);
  });

  it('can force-stop a process that ignores SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
      },
    );
    expect(child.pid).toBeDefined();
    const pid = child.pid!;
    expect(isPidRunning(pid)).toBe(true);

    const result = await stopPid(pid, { timeoutMs: 200, force: true, useProcessGroup: true });
    expect(['stopped', 'force-stopped']).toContain(result);
    expect(isPidRunning(pid)).toBe(false);
  });

  it('validates ownership metadata against process info', () => {
    const info = {
      pid: 4321,
      uid: 501,
      startedAt: 'Mon Mar 02 11:11:11 2026',
      command: '/usr/bin/node __supervisor',
    };

    const matching = isOwnershipMatch(
      {
        ownerPid: 4321,
        pid: 4321,
        port: 7070,
        host: '127.0.0.1',
        startedAt: Date.now(),
        version: '0.2.0',
        mode: 'supervisor',
        ownerUid: info.uid,
        ownerStartedAt: info.startedAt,
        ownerCommand: '__supervisor',
      },
      info,
    );
    expect(matching).toBe(true);

    const mismatchedUid = isOwnershipMatch(
      {
        ownerPid: 4321,
        pid: 4321,
        port: 7070,
        host: '127.0.0.1',
        startedAt: Date.now(),
        version: '0.2.0',
        mode: 'supervisor',
        ownerUid: info.uid + 1,
      },
      info,
    );
    expect(mismatchedUid).toBe(false);

    const mismatchedCommand = isOwnershipMatch(
      {
        ownerPid: 4321,
        pid: 4321,
        port: 7070,
        host: '127.0.0.1',
        startedAt: Date.now(),
        version: '0.2.0',
        mode: 'supervisor',
        ownerCommand: '__definitely-not-this-process__',
      },
      info,
    );
    expect(mismatchedCommand).toBe(false);

    const mismatchedHost = isOwnershipMatch(
      {
        ownerPid: 4321,
        pid: 4321,
        port: 7070,
        host: '127.0.0.1',
        startedAt: Date.now(),
        version: '0.2.0',
        mode: 'supervisor',
        ownerHostname: '__remote-host__',
      },
      info,
    );
    expect(mismatchedHost).toBe(false);
  });
});
