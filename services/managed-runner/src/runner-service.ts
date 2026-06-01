import { randomUUID } from 'node:crypto';
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
      'vpd worker start --mode ephemeral --transport polling --run-once --lease "$VIEWPORT_RUN_LEASE_TOKEN"'
    );
  }

  private redactCommand(command: string, secrets: EphemeralSecret[] = []): string {
    return redact(command, secrets) ?? command;
  }
}

function tail(output: string, max = 4000): string {
  return output.length > max ? output.slice(output.length - max) : output;
}
