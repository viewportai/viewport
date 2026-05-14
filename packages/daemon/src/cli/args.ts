/**
 * CLI argument parsing helpers.
 */

import path from 'node:path';

const rawArgs = process.argv.slice(2);
const args = stripLeadingGlobalArgs(rawArgs);

function applyTopLevelOverrides(): void {
  let index = 0;
  while (index < rawArgs.length) {
    const entry = rawArgs[index];
    if (entry === '--home') {
      const raw = rawArgs[index + 1];
      if (raw && !raw.startsWith('--')) {
        process.env['VIEWPORT_HOME'] = path.resolve(raw);
        index += 2;
        continue;
      }
      break;
    }
    if (typeof entry === 'string' && entry.startsWith('--home=')) {
      const raw = entry.slice('--home='.length);
      if (raw.length > 0) process.env['VIEWPORT_HOME'] = path.resolve(raw);
      index += 1;
      continue;
    }
    if (entry === '--profile') {
      const raw = rawArgs[index + 1];
      if (raw && !raw.startsWith('--')) {
        process.env['VIEWPORT_PROFILE'] = raw;
        index += 2;
        continue;
      }
      break;
    }
    if (typeof entry === 'string' && entry.startsWith('--profile=')) {
      const raw = entry.slice('--profile='.length);
      if (raw.length > 0) process.env['VIEWPORT_PROFILE'] = raw;
      index += 1;
      continue;
    }
    break;
  }
}

function stripLeadingGlobalArgs(values: string[]): string[] {
  let index = 0;
  while (index < values.length) {
    const entry = values[index];
    if (entry === '--home' || entry === '--profile') {
      index += 2;
      continue;
    }
    if (
      typeof entry === 'string' &&
      (entry.startsWith('--home=') || entry.startsWith('--profile='))
    ) {
      index += 1;
      continue;
    }
    break;
  }
  return values.slice(index);
}

applyTopLevelOverrides();

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
