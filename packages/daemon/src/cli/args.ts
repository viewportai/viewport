/**
 * CLI argument parsing helpers.
 */

import path from 'node:path';

const args = process.argv.slice(2);

function applyHomeOverride(): void {
  const idx = args.indexOf('--home');
  if (idx === -1 || idx + 1 >= args.length) return;
  const raw = args[idx + 1];
  if (!raw || raw.startsWith('--')) return;
  process.env['VIEWPORT_HOME'] = path.resolve(raw);
}

applyHomeOverride();

export function getCommand(): string {
  return args[0] ?? 'help';
}

export function getArgs(): string[] {
  return args;
}

export function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function getDaemonPort(): number {
  return parseInt(getFlag('port') ?? '7070', 10);
}

export function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}
