import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { redact } from './redaction.js';
import type {
  EphemeralSecret,
  ManagedRunRecord,
  ManagedRunStartRequest,
  ManagedSandboxProvider,
  ManagedRunnerStatus,
} from './types.js';

export class ManagedRunnerService {
  private readonly records = new Map<string, ManagedRunRecord>();

  constructor(private readonly provider: ManagedSandboxProvider) {}

  async start(request: ManagedRunStartRequest): Promise<ManagedRunRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const sandbox = await this.provider.create(this.baseEnv(request));
    const command = this.workerCommand(request);
    const record: ManagedRunRecord = {
      id,
      provider: this.provider.name,
      providerSandboxId: sandbox.id,
      status: 'provisioning',
      workspaceId: request.workspaceId,
      runId: request.runId,
      startedAt: now,
      updatedAt: now,
      command: this.redactCommand(command, request.secrets),
    };
      this.records.set(id, record);

    try {
      await this.writeBootstrap(sandbox, request);
      await this.writeVpdPackageOverride(sandbox);
      await this.writeCodexAuthOverride(sandbox);
      await sandbox.run(request.vpdInstallCommand, {
        timeoutMs: request.timeoutMs,
      });
      this.patch(id, { status: 'running' });
      const result = await sandbox.run(command, {
        env: this.commandEnv(request),
        timeoutMs: request.timeoutMs,
      });
      this.patch(id, {
        status: result.exitCode === undefined || result.exitCode === 0 ? 'completed' : 'failed',
        stdoutTail: redact(tail(result.stdout), request.secrets),
        stderrTail: redact(tail(result.stderr), request.secrets),
        exitCode: result.exitCode,
      });
    } catch (error) {
      this.patch(id, {
        status: 'failed',
        error: redact(error instanceof Error ? error.message : String(error), request.secrets),
      });
    } finally {
      await sandbox.kill().catch(() => undefined);
    }

    return this.get(id) as ManagedRunRecord;
  }

  get(id: string): ManagedRunRecord | undefined {
    return this.records.get(id);
  }

  async destroy(id: string): Promise<ManagedRunRecord | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    this.patch(id, { status: 'destroyed' });
    return this.records.get(id);
  }

  private patch(id: string, patch: Partial<ManagedRunRecord> & { status?: ManagedRunnerStatus }): void {
    const current = this.records.get(id);
    if (!current) return;
    this.records.set(id, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  private baseEnv(request: ManagedRunStartRequest): Record<string, string> {
    return {
      VIEWPORT_MANAGED_RUN: '1',
      VIEWPORT_WORKSPACE_ID: request.workspaceId,
      VIEWPORT_RUN_ID: request.runId,
      ...(process.env.CODEX_AUTH_JSON_PATH?.trim() ? { CODEX_HOME: '/home/user/.codex' } : {}),
      ...(request.env ?? {}),
    };
  }

  private commandEnv(request: ManagedRunStartRequest): Record<string, string> {
    return {
      ...this.baseEnv(request),
      VIEWPORT_SERVER_URL: request.serverUrl,
      VIEWPORT_RUN_LEASE_TOKEN: request.leaseToken,
      ...Object.fromEntries((request.secrets ?? []).map((secret) => [secret.name, secret.value])),
    };
  }

  private workerCommand(request: ManagedRunStartRequest): string {
    return (
      request.workerCommand ??
      (request.bootstrap
        ? `vpd worker run-once --bootstrap ${this.bootstrapPath(request)} --json`
        : 'vpd worker start --mode ephemeral --transport polling --run-once --lease "$VIEWPORT_RUN_LEASE_TOKEN"')
    );
  }

  private redactCommand(command: string, secrets: EphemeralSecret[] = []): string {
    return redact(command, secrets) ?? command;
  }

  private async writeBootstrap(sandbox: Awaited<ReturnType<ManagedSandboxProvider['create']>>, request: ManagedRunStartRequest): Promise<void> {
    if (!request.bootstrap) return;
    if (!sandbox.writeFile) {
      throw new Error('sandbox_provider_does_not_support_file_write');
    }
    await sandbox.writeFile(this.bootstrapPath(request), `${JSON.stringify(request.bootstrap, null, 2)}\n`);
  }

  private async writeVpdPackageOverride(sandbox: Awaited<ReturnType<ManagedSandboxProvider['create']>>): Promise<void> {
    const tarballPath = process.env.VPD_PACKAGE_TARBALL?.trim();
    if (!tarballPath) return;
    if (!sandbox.writeFile) {
      throw new Error('sandbox_provider_does_not_support_file_write');
    }

    const tarball = await readFile(tarballPath, { encoding: 'base64' });
    await sandbox.writeFile('/tmp/viewport/vpd.tgz.b64', tarball);
  }

  private async writeCodexAuthOverride(sandbox: Awaited<ReturnType<ManagedSandboxProvider['create']>>): Promise<void> {
    const authPath = process.env.CODEX_AUTH_JSON_PATH?.trim();
    if (!authPath) return;
    if (!sandbox.writeFile) {
      throw new Error('sandbox_provider_does_not_support_file_write');
    }

    await sandbox.run('mkdir -p /home/user/.codex && chmod 700 /home/user/.codex');
    await sandbox.writeFile('/home/user/.codex/auth.json', await readFile(authPath, 'utf8'));
    await sandbox.run('chmod 600 /home/user/.codex/auth.json');
  }

  private bootstrapPath(request: ManagedRunStartRequest): string {
    const path = request.bootstrapPath?.trim();
    return path && path.startsWith('/') ? path : '/tmp/viewport/bootstrap.json';
  }
}

function tail(output: string, max = 4000): string {
  return output.length > max ? output.slice(output.length - max) : output;
}
