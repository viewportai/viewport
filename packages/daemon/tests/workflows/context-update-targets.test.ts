import { describe, expect, it } from 'vitest';
import {
  gitContextTargetAllowsPath,
  parseGitContextUpdateTargetRef,
} from '../../src/workflows/context-update-targets.js';

describe('Git context update target refs', () => {
  it('parses repo, directory, and file scoped refs', () => {
    expect(parseGitContextUpdateTargetRef('git://viewportai/vp-example-docs')).toEqual({
      provider: 'git',
      owner: 'viewportai',
      repo: 'vp-example-docs',
      repository: 'viewportai/vp-example-docs',
      path: null,
      scope: 'repo',
    });
    expect(parseGitContextUpdateTargetRef('git://viewportai/vp-example-docs/docs/context/')).toEqual({
      provider: 'git',
      owner: 'viewportai',
      repo: 'vp-example-docs',
      repository: 'viewportai/vp-example-docs',
      path: 'docs/context/',
      scope: 'directory',
    });
    expect(
      parseGitContextUpdateTargetRef(
        'git://viewportai/vp-example-docs/docs/context/payment-risk-rules.md',
      ),
    ).toEqual({
      provider: 'git',
      owner: 'viewportai',
      repo: 'vp-example-docs',
      repository: 'viewportai/vp-example-docs',
      path: 'docs/context/payment-risk-rules.md',
      scope: 'file',
    });
  });

  it('checks proposed files against target scope', () => {
    const directory = parseGitContextUpdateTargetRef(
      'git://viewportai/vp-example-docs/docs/context/',
    );
    const file = parseGitContextUpdateTargetRef(
      'git://viewportai/vp-example-docs/docs/context/payment-risk-rules.md',
    );
    const repo = parseGitContextUpdateTargetRef('git://viewportai/vp-example-docs');

    expect(directory && gitContextTargetAllowsPath(directory, 'docs/context/support.md')).toBe(true);
    expect(directory && gitContextTargetAllowsPath(directory, 'docs/runbooks/support.md')).toBe(false);
    expect(file && gitContextTargetAllowsPath(file, 'docs/context/payment-risk-rules.md')).toBe(true);
    expect(file && gitContextTargetAllowsPath(file, 'docs/context/other.md')).toBe(false);
    expect(repo && gitContextTargetAllowsPath(repo, 'any/path.md')).toBe(true);
    expect(repo && gitContextTargetAllowsPath(repo, '../escape.md')).toBe(false);
  });
});
