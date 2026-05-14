import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { Daemon } from '../../../src/core/daemon.js';
import { registerHttpRoutes } from '../../../src/server/http-server.js';
import { registerWsServer } from '../../../src/server/ws-server.js';
import { buildSecurityProfile } from '../../../src/server/security.js';
import {
  writeDaemonRuntimeState,
  clearDaemonRuntimeState,
} from '../../../src/cli/daemon-lifecycle.js';
import { FakeAdapter } from './fake-agent.js';
import { GitTracker } from '../../../src/tracking/git-tracker.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args], { timeout: 30_000 });
}

export class FullstackCliHarness {
  private readonly daemon = new Daemon();
  private readonly app = Fastify();
  private readonly adapter = new FakeAdapter('fake', { autoReply: true, replyPrefix: 'ok' });

  private tempHome = '';
  private originalHome = '';
  private originalViewportHome = '';
  private listenPort = 0;

  get fakeAdapter(): FakeAdapter {
    return this.adapter;
  }

  get daemonInstance(): Daemon {
    return this.daemon;
  }

  static async start(): Promise<FullstackCliHarness> {
    const harness = new FullstackCliHarness();
    await harness.setup();
    return harness;
  }

  async createGitProject(prefix = 'viewport-fullstack-project-'): Promise<string> {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    await git(projectPath, ['init']);
    await git(projectPath, ['config', 'user.name', 'Viewport E2E']);
    await git(projectPath, ['config', 'user.email', 'e2e@viewport.test']);
    await fs.writeFile(path.join(projectPath, 'README.md'), '# E2E\n', 'utf-8');
    await git(projectPath, ['add', 'README.md']);
    await git(projectPath, ['commit', '-m', 'initial']);
    return projectPath;
  }

  async currentBranch(projectPath: string): Promise<string> {
    const { stdout } = await exec('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  async close(): Promise<void> {
    await clearDaemonRuntimeState();
    await this.daemon.shutdown();
    await this.app.close();
    if (this.originalHome) process.env['HOME'] = this.originalHome;
    else delete process.env['HOME'];
    if (this.originalViewportHome) process.env['VIEWPORT_HOME'] = this.originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    if (this.tempHome) {
      await fs.rm(this.tempHome, { recursive: true, force: true });
    }
  }

  private async setup(): Promise<void> {
    this.tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-fullstack-home-'));
    this.originalHome = process.env['HOME'] ?? '';
    this.originalViewportHome = process.env['VIEWPORT_HOME'] ?? '';
    process.env['HOME'] = this.tempHome;
    process.env['VIEWPORT_HOME'] = path.join(this.tempHome, '.viewport');

    await this.daemon.initialize();
    this.daemon.registerAdapter(this.adapter);
    await this.daemon.configManager.setDefaults({
      agent: 'fake',
      gitTracker: {
        enabled: true,
        commitOn: ['Write'],
        ignore: ['.env', '.env.*', 'node_modules/**', 'dist/**', '.viewport/**'],
        autoSquashOnComplete: false,
        branchPrefix: 'viewport/session-',
        commitAuthor: 'Viewport Agent <noreply@example.test>',
        maxCommitsPerSession: 500,
        worktreeRoot: '.viewport/worktrees',
      },
    });
    this.daemon.setTrackerFactory(
      (trackerConfig, sessionId) => new GitTracker(trackerConfig, sessionId),
    );

    const securityProfile = buildSecurityProfile({
      profile: 'local',
      host: '127.0.0.1',
      explicitAuthFlag: false,
    });

    await this.app.register(fastifyWebsocket);
    registerHttpRoutes(this.app, this.daemon, undefined, {
      runtime: {
        pid: process.pid,
        host: '127.0.0.1',
        port: 0,
        startedAt: Date.now(),
        version: 'e2e',
      },
      securityProfile,
    });
    registerWsServer(this.app, this.daemon, undefined, { securityProfile });
    await this.app.listen({ host: '127.0.0.1', port: 0 });
    const address = this.app.server.address() as AddressInfo | null;
    this.listenPort = address?.port ?? 0;
    if (this.listenPort <= 0) {
      throw new Error('Failed to allocate fullstack CLI harness port.');
    }

    await writeDaemonRuntimeState({
      ownerPid: process.pid,
      pid: process.pid,
      workerPid: process.pid,
      port: this.listenPort,
      host: '127.0.0.1',
      listen: `127.0.0.1:${this.listenPort}`,
      startedAt: Date.now(),
      version: 'e2e',
      mode: 'worker',
      profile: 'local',
      authEnabled: false,
    });
  }
}
