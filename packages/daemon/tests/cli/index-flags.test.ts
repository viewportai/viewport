import { describe, expect, it } from 'vitest';
import { resolveGlobalFlag } from '../../src/cli/global-flags.js';

describe('cli global flags', () => {
  it('detects help flags before command dispatch', () => {
    expect(resolveGlobalFlag(['--help'])).toBe('help');
    expect(resolveGlobalFlag(['-h'])).toBe('help');
  });

  it('detects version flags before command dispatch', () => {
    expect(resolveGlobalFlag(['--version'])).toBe('version');
    expect(resolveGlobalFlag(['-v'])).toBe('version');
  });

  it('ignores non-global args', () => {
    expect(resolveGlobalFlag(['status'])).toBeNull();
  });
});
