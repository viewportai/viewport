import { randomUUID } from 'node:crypto';
import type { CommandResult, ManagedSandbox, ManagedSandboxProvider } from './types.js';

export class FakeSandbox implements ManagedSandbox {
  readonly id = `fake-${randomUUID()}`;
  readonly commands: Array<{ command: string; env?: Record<string, string> }> = [];
  killed = false;

  async run(command: string, options: { env?: Record<string, string> } = {}): Promise<CommandResult> {
    if (this.killed) {
      throw new Error('sandbox_destroyed');
    }
    this.commands.push({ command, env: options.env });
    return {
      stdout: `ran:${command}`,
      stderr: '',
      exitCode: 0,
    };
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

export class FakeSandboxProvider implements ManagedSandboxProvider {
  readonly name = 'fake' as const;
  readonly sandboxes: FakeSandbox[] = [];

  async create(): Promise<FakeSandbox> {
    const sandbox = new FakeSandbox();
    this.sandboxes.push(sandbox);
    return sandbox;
  }
}
