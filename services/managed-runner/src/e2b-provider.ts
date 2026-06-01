import { CommandExitError, Sandbox } from 'e2b';
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
    let result;
    try {
      result = await this.sandbox.commands.run(command, {
        envs: options.env,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          stdout: error.stdout,
          stderr: error.stderr || error.error || error.message,
          exitCode: error.exitCode,
        };
      }

      throw error;
    }

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

  constructor(private readonly template?: string) {}

  async create(env?: Record<string, string>): Promise<ManagedSandbox> {
    const opts = {
      envs: env,
      metadata: {
        service: 'viewport-managed-runner',
      },
    };
    const sandbox = this.template ? await Sandbox.create(this.template, opts) : await Sandbox.create(opts);

    return new E2bSandbox(sandbox);
  }
}
