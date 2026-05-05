import os from 'node:os';
import path from 'node:path';

/**
 * Decode a Claude Code project directory name back to a filesystem path.
 * Claude-style encoding:
 *   '/'  -> '-'
 *   '-'  -> '--'
 * Example: /Users/dev-user/my-project -> -Users-dev--user-my--project
 */
export function decodeProjectDir(dirName: string): string {
  const hasLeadingSlash = dirName.startsWith('-');
  const source = hasLeadingSlash ? dirName.slice(1) : dirName;
  let decoded = '';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '-') {
      decoded += ch;
      continue;
    }
    const next = source[i + 1];
    if (next === '-') {
      decoded += '-';
      i += 1;
    } else {
      decoded += '/';
    }
  }

  return hasLeadingSlash ? `/${decoded}` : decoded;
}

/**
 * Encode a filesystem path to a Claude Code project directory name.
 * '/'  -> '-'
 * '-'  -> '--'
 */
export function encodeProjectDir(fsPath: string): string {
  const normalized = path.resolve(fsPath);
  let encoded = '';
  for (const ch of normalized) {
    if (ch === '/') {
      encoded += '-';
    } else if (ch === '-') {
      encoded += '--';
    } else {
      encoded += ch;
    }
  }
  return encoded;
}

/** Path to Claude Code's projects directory. */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}
