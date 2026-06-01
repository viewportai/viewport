import http from 'node:http';
import { z } from 'zod';
import { ManagedRunnerService } from './runner-service.js';

const SecretSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  redactionHint: z.string().min(1).optional(),
});

const StartSchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  leaseToken: z.string().min(1),
  serverUrl: z.string().url(),
  vpdInstallCommand: z.string().min(1),
  workerCommand: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(SecretSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export function createServer(service: ManagedRunnerService): http.Server {
  return http.createServer((req, res) => {
    void handle(service, req, res);
  });
}

async function handle(service: ManagedRunnerService, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return writeJson(res, 200, { ok: true, service: 'managed-runner' });
  }
  if (req.method === 'POST' && url.pathname === '/runs') {
    const parsed = StartSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return writeJson(res, 422, { ok: false, error: 'invalid_request', issues: parsed.error.issues });
    }
    return writeJson(res, 202, { ok: true, data: await service.start(parsed.data) });
  }
  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch && req.method === 'GET') {
    const record = service.get(runMatch[1]);
    return writeJson(res, record ? 200 : 404, record ? { ok: true, data: record } : { ok: false, error: 'not_found' });
  }
  if (runMatch && req.method === 'DELETE') {
    const record = await service.destroy(runMatch[1]);
    return writeJson(res, record ? 200 : 404, record ? { ok: true, data: record } : { ok: false, error: 'not_found' });
  }
  return writeJson(res, 404, { ok: false, error: 'not_found' });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
