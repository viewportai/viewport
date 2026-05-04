import { spawn } from 'node:child_process';
import os from 'node:os';

export async function resolveDefaultPairingName(): Promise<string> {
  const explicitName = sanitizePairingName(process.env['VIEWPORT_MACHINE_NAME']);
  if (explicitName) return explicitName;

  if (process.platform === 'darwin') {
    const computerName = sanitizePairingName(
      await readCommandText('scutil', ['--get', 'ComputerName']),
    );
    if (computerName) return computerName;

    const localHostName = sanitizePairingName(
      await readCommandText('scutil', ['--get', 'LocalHostName']),
    );
    if (localHostName) return localHostName;
  }

  if (process.platform === 'linux') {
    const prettyName = sanitizePairingName(await readCommandText('hostnamectl', ['--pretty']));
    if (prettyName) return prettyName;
  }

  return sanitizePairingName(os.hostname()) ?? 'Viewport machine';
}

function sanitizePairingName(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, 80);
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
