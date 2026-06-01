import { Sandbox } from 'e2b';
import type { CommandResult, ManagedSandbox, ManagedSandboxProvider } from './types.js';

class E2bSandbox implements ManagedSandbox {
  readonly id: string;

  constructor(private readonly sandbox: Sandbox) {
    this.id = sandbox.sandboxId;
  }

  async writeFile(path: string, data: string): Promise<void> {
    await this.sandbox.files.write(path, data);
  }

  async run(command: string, options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<CommandResult> {
    const result = await this.sandbox.commands.run(command, {
      envs: options.env,
      timeoutMs: options.timeoutMs,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  async kill(): Promise<void> {
    await this.sandbox.kill();
  }
}

export class E2bSandboxProvider implements ManagedSandboxProvider {
  readonly name = 'e2b' as const;

  async create(env?: Record<string, string>): Promise<ManagedSandbox> {
    const sandbox = await Sandbox.create({
      envs: env,
      metadata: {
        service: 'viewport-managed-runner',
      },
    });

    return new E2bSandbox(sandbox);
  }
}
