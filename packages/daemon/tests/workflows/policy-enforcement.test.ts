import { describe, expect, it } from 'vitest';
import {
  checkShellPolicy,
  branchIsRestricted,
  restrictedPathsTouched,
  matchesGlob,
} from '../../src/workflows/policy-enforcement.js';

describe('checkShellPolicy', () => {
  it('blocks a command matching a denied pattern', () => {
    const d = checkShellPolicy('rm -rf /tmp/x', { denied: ['rm -rf *'] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('denied pattern');
  });

  it('allows a command that matches no denied pattern', () => {
    expect(checkShellPolicy('ls -la', { denied: ['rm -rf *', 'curl *'] }).allowed).toBe(true);
  });

  it('with a non-empty allowlist, rejects commands not on it', () => {
    const policy = { allowed: ['git *', 'npm *'] };
    expect(checkShellPolicy('git status', policy).allowed).toBe(true);
    const blocked = checkShellPolicy('curl evil.com', policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('allowed list');
  });

  it('denied takes precedence over allowed', () => {
    const policy = { allowed: ['git *'], denied: ['git push *'] };
    expect(checkShellPolicy('git push origin main', policy).allowed).toBe(false);
  });

  it('empty policy allows everything', () => {
    expect(checkShellPolicy('anything goes', {}).allowed).toBe(true);
  });

  // The documented prefix-vs-exact caveat — guards against false sense of security.
  it('exact pattern (no wildcard) blocks ONLY the exact string', () => {
    expect(checkShellPolicy('rm -rf', { denied: ['rm -rf'] }).allowed).toBe(false);
    expect(checkShellPolicy('rm -rf /tmp', { denied: ['rm -rf'] }).allowed).toBe(true); // needs a trailing *
  });
});

describe('branchIsRestricted', () => {
  it('blocks an exact restricted branch', () => {
    expect(branchIsRestricted('main', ['main'])).toBe(true);
    expect(branchIsRestricted('agent/fix', ['main'])).toBe(false);
  });

  it('matches a glob restriction', () => {
    expect(branchIsRestricted('release/1.2', ['release/*'])).toBe(true);
    expect(branchIsRestricted('agent/feature', ['release/*'])).toBe(false);
  });

  it('no restrictions → never restricted', () => {
    expect(branchIsRestricted('main', [])).toBe(false);
    expect(branchIsRestricted('main', undefined)).toBe(false);
  });
});

describe('restrictedPathsTouched', () => {
  it('flags changed paths under a restricted ** glob', () => {
    const touched = restrictedPathsTouched(
      ['src/app.ts', 'src/security/signature.ts', 'README.md'],
      ['src/security/**'],
    );
    expect(touched).toEqual(['src/security/signature.ts']);
  });

  it('returns empty when nothing restricted is touched', () => {
    expect(restrictedPathsTouched(['src/app.ts'], ['src/security/**'])).toEqual([]);
  });
});

describe('matchesGlob', () => {
  it('* matches within a segment, ** across segments', () => {
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/*.ts')).toBe(false); // * does not cross /
    expect(matchesGlob('src/deep/a.ts', 'src/**')).toBe(true); // ** crosses /
  });
});
