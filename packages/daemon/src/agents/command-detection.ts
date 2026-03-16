import { execFile } from 'node:child_process';

/**
 * Check whether a command exists on PATH.
 * Uses `which` on Unix-like systems and `where` on Windows.
 */
export async function commandExists(command: string): Promise<boolean> {
  const detector = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(detector, [command], (err) => resolve(!err));
  });
}
