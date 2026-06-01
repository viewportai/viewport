import { FakeSandboxProvider } from './fake-provider.js';
import { createServer } from './http.js';
import { ManagedRunnerService } from './runner-service.js';

const port = Number.parseInt(process.env['PORT'] ?? '7091', 10);
const host = process.env['HOST'] ?? '127.0.0.1';

const service = new ManagedRunnerService(new FakeSandboxProvider());
const server = createServer(service);

server.listen(port, host, () => {
  console.log(`[managed-runner] listening on http://${host}:${port}`);
});
