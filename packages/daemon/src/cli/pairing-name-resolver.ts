import { spawn } from 'node:child_process';
import os from 'node:os';
import { sanitizeMachineDisplayName } from '../core/machine-name.js';

export async function resolveDefaultPairingName(): Promise<string> {
  const explicitName = sanitizeMachineDisplayName(process.env['VIEWPORT_MACHINE_NAME']);
  if (explicitName) return explicitName;

  if (process.platform === 'darwin') {
    const computerName = sanitizeMachineDisplayName(
      await readCommandText('scutil', ['--get', 'ComputerName']),
    );
    if (computerName) return computerName;

    const localHostName = sanitizeMachineDisplayName(
      await readCommandText('scutil', ['--get', 'LocalHostName']),
    );
    if (localHostName) return localHostName;
  }

  if (process.platform === 'linux') {
    const prettyName = sanitizeMachineDisplayName(
      await readCommandText('hostnamectl', ['--pretty']),
    );
    if (prettyName) return prettyName;
  }

  return sanitizeMachineDisplayName(os.hostname()) ?? 'Viewport machine';
}

function readCommandText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 1_000);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : null);
    });
  });
}
