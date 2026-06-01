import { E2bSandboxProvider } from './e2b-provider.js';
import { FakeSandboxProvider } from './fake-provider.js';
import { createServer } from './http.js';
import { ManagedRunnerService } from './runner-service.js';

const port = Number.parseInt(process.env['PORT'] ?? '7091', 10);
const host = process.env['HOST'] ?? '127.0.0.1';
const providerName = process.env['MANAGED_RUNNER_PROVIDER'] ?? (process.env['E2B_API_KEY'] ? 'e2b' : 'fake');
const e2bTemplate = process.env['E2B_TEMPLATE'];

const service = new ManagedRunnerService(
  providerName === 'e2b' ? new E2bSandboxProvider(e2bTemplate) : new FakeSandboxProvider(),
);
const server = createServer(service);

server.listen(port, host, () => {
  console.log(`[managed-runner] listening on http://${host}:${port} provider=${providerName}`);
});
