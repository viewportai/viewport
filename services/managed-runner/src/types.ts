export type ManagedRunnerStatus = 'provisioning' | 'running' | 'completed' | 'failed' | 'destroyed';

export type EphemeralSecret = {
  name: string;
  value: string;
  redactionHint?: string;
};

export type ManagedRunStartRequest = {
  runId: string;
  workspaceId: string;
  leaseToken: string;
  serverUrl: string;
  vpdInstallCommand: string;
  workerCommand?: string;
  bootstrap?: Record<string, unknown>;
  bootstrapPath?: string;
  env?: Record<string, string>;
  secrets?: EphemeralSecret[];
  timeoutMs?: number;
};

export type ManagedRunRecord = {
  id: string;
  provider: 'e2b' | 'fake';
  providerSandboxId: string;
  status: ManagedRunnerStatus;
  workspaceId: string;
  runId: string;
  startedAt: string;
  updatedAt: string;
  command?: string;
  stdoutTail?: string;
  stderrTail?: string;
  exitCode?: number;
  error?: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
};

export interface ManagedSandbox {
  id: string;
  writeFile?(path: string, data: string): Promise<void>;
  run(command: string, options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<CommandResult>;
  kill(): Promise<void>;
}

export interface ManagedSandboxProvider {
  name: 'e2b' | 'fake';
  create(env?: Record<string, string>): Promise<ManagedSandbox>;
}
