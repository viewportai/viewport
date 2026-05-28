import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Daemon } from '../../../src/core/daemon.js';
import { registerWsServer } from '../../../src/server/ws-server.js';
import { HookRouter } from '../../../src/hooks/router.js';
import { SupervisionManager } from '../../../src/hooks/supervision.js';
import type { AgentAdapter, SessionDiscovery } from '../../../src/core/interfaces.js';
import type { DirectoryInfo } from '../../../src/core/types.js';

export type WsMessage = Record<string, unknown>;

type MessageWaiter = {
  predicate: (msg: WsMessage) => boolean;
  resolve: (msg: WsMessage) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class ProtocolClient {
  private readonly ws: WebSocket;
  private readonly buffered: WsMessage[] = [];
  private readonly waiters: MessageWaiter[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString()) as WsMessage;
      this.deliver(parsed);
    });
  }

  async waitForOpen(timeoutMs = 5_000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for WS open')), timeoutMs);
      this.ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(message: WsMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  nextMessage(timeoutMs = 5_000): Promise<WsMessage> {
    return this.waitFor(() => true, timeoutMs);
  }

  waitForType(type: string, timeoutMs = 5_000): Promise<WsMessage> {
    return this.waitFor((msg) => msg['type'] === type, timeoutMs);
  }

  waitForAck(requestId: string, timeoutMs = 5_000): Promise<WsMessage> {
    return this.waitFor(
      (msg) => msg['type'] === 'ack' && msg['requestId'] === requestId,
      timeoutMs,
    );
  }

  async collectMessages(count: number, timeoutMs = 5_000): Promise<WsMessage[]> {
    const messages: WsMessage[] = [];
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < count; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timeout collecting messages: received ${messages.length}/${count}`);
      }
      messages.push(await this.nextMessage(remaining));
    }
    return messages;
  }

  waitFor(predicate: (msg: WsMessage) => boolean, timeoutMs = 5_000): Promise<WsMessage> {
    const bufferedIndex = this.buffered.findIndex(predicate);
    if (bufferedIndex !== -1) {
      const [match] = this.buffered.splice(bufferedIndex, 1);
      return Promise.resolve(match as WsMessage);
    }

    return new Promise<WsMessage>((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new Error('Timeout waiting for message'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.ws.terminate();
  }

  private deliver(message: WsMessage): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timeout);
      waiter!.resolve(message);
      return;
    }
    this.buffered.push(message);
  }
}

export interface ProtocolHarnessOptions {
  adapters?: AgentAdapter[];
  discoveries?: SessionDiscovery[];
  hooks?: boolean;
}

export class ProtocolHarness {
  private tempHome = '';
  private originalHome = '';

  readonly daemon = new Daemon();
  readonly app = Fastify();
  readonly supervision = new SupervisionManager();
  readonly hookRouter = new HookRouter(this.daemon, this.supervision);

  private constructor() {}

  static async start(options?: ProtocolHarnessOptions): Promise<ProtocolHarness> {
    const harness = new ProtocolHarness();
    await harness.setup(options);
    return harness;
  }

  async createProject(prefix = 'viewport-e2e-project-'): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async registerDirectory(projectPath: string): Promise<DirectoryInfo> {
    return this.daemon.directoryManager.register(projectPath);
  }

  async runDiscoveryBroadcast(): Promise<void> {
    await this.daemon.runDiscovery();
    this.daemon.emit('discovery:updated', {});
  }

  async connectClient(): Promise<ProtocolClient> {
    let client: ProtocolClient | null = null;
    const ws = (await this.app.injectWS(
      '/ws',
      {},
      {
        onInit: (raw) => {
          client = new ProtocolClient(raw as unknown as WebSocket);
        },
      },
    )) as unknown as WebSocket;

    const connected = client ?? new ProtocolClient(ws);
    await connected.waitForOpen();
    return connected;
  }

  async close(): Promise<void> {
    await this.daemon.shutdown();
    await this.app.close();
    if (this.originalHome) {
      process.env['HOME'] = this.originalHome;
    }
    if (this.tempHome) {
      await fs.rm(this.tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  private async setup(options?: ProtocolHarnessOptions): Promise<void> {
    this.tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-e2e-home-'));
    this.originalHome = process.env['HOME'] ?? '';
    process.env['HOME'] = this.tempHome;

    await this.daemon.initialize();

    for (const adapter of options?.adapters ?? []) {
      this.daemon.registerAdapter(adapter);
    }
    for (const discovery of options?.discoveries ?? []) {
      this.daemon.registerDiscovery(discovery);
    }

    await this.app.register(fastifyWebsocket);
    registerWsServer(this.app, this.daemon, undefined, {
      hookRouter: options?.hooks ? this.hookRouter : undefined,
      supervision: options?.hooks ? this.supervision : undefined,
    });
    await this.app.ready();
  }
}
