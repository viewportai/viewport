import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { resolveDaemonEndpoint } from './daemon-client.js';

interface AckMessage {
  type: 'ack';
  requestId?: string;
  status?: 'ok' | 'error';
  error?: string;
  errorCode?: string;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class DaemonWsClient {
  private readonly events = new EventEmitter();
  private socket: WebSocket | null = null;

  async connect(timeoutMs = 5_000): Promise<void> {
    const endpoint = await resolveDaemonEndpoint();
    const socket = new WebSocket(endpoint.wsUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        safeTerminate(socket);
        reject(new Error(`Timed out connecting to daemon websocket after ${timeoutMs}ms`));
      }, timeoutMs);

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('error', onError);
      };

      socket.on('open', onOpen);
      socket.on('error', onError);
    });

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf-8'));
      } catch {
        return;
      }
      this.events.emit('message', parsed);
    });
  }

  close(): void {
    if (!this.socket) return;
    safeClose(this.socket);
    this.socket = null;
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.events.on('message', handler);
    return () => {
      this.events.off('message', handler);
    };
  }

  send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.socket.send(JSON.stringify(payload));
  }

  async waitForMessage<T>(
    predicate: (message: unknown) => message is T,
    timeoutMs = 10_000,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (message: unknown) => {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.events.off('message', onMessage);
      };

      this.events.on('message', onMessage);
    });
  }

  async requestAck(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<AckMessage> {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const waitAck = this.waitForMessage<AckMessage>((message: unknown): message is AckMessage => {
      if (!isObject(message)) return false;
      return message['type'] === 'ack' && message['requestId'] === requestId;
    }, timeoutMs);

    this.send({
      ...payload,
      requestId,
    });

    const ack = await waitAck;
    if (ack.status !== 'ok') {
      const code = typeof ack.errorCode === 'string' ? ` (${ack.errorCode})` : '';
      throw new Error(`${ack.error ?? 'Command rejected'}${code}`);
    }
    return ack;
  }
}

function safeTerminate(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.terminate();
    }
  } catch {
    // The socket may race closed while a connect timeout fires. Treat that as closed.
  }
}

function safeClose(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  } catch {
    // Best-effort cleanup for CLI commands; callers only care that the handle is released.
  }
}
