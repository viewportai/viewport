# Releasing and npm Publish

## Current source of truth

1. npm package name: `@viewportai/daemon` (`package.json` `name`).
2. Version source: semantic-release from commit history on `main`.
3. Publish trigger: `.github/workflows/release.yml` after `CI` succeeds on a push to `main`.
4. npm auth: granular `NPM_TOKEN` secret in GitHub Actions.

## Version rules

1. `feat:` => `minor` (for example `0.4.0` -> `0.5.0`).
2. `fix:` => `patch` (for example `0.4.1` -> `0.4.2`).
3. `perf:` / `refactor:` / `revert:` => `patch`.
4. `BREAKING CHANGE:` footer or `!` in type/scope => `major`.
5. `docs:`, `test:`, `chore:` alone => no release.

## One-time setup for production publish

1. Create npm organization scope `@viewportai` (or verify ownership if it already exists).
2. Ensure repository package name remains `@viewportai/daemon`.
3. Create a granular npm token with publish rights to `@viewportai/daemon`.
4. Add GitHub Actions secret `NPM_TOKEN` in repo settings.
5. Ensure branch protection on `main` requires the `CI` workflow to pass before merge.
6. Ensure branch protection on `main` requires the `Semantic PR` workflow to pass before merge.
7. Use squash-merge so the semantic PR title becomes the release-driving commit on `main`.
8. Ensure npm package access is public (already configured via `publishConfig.access=public`).
9. For this repository, enforce a pre-1.0 stream with a one-time baseline tag on the bootstrap `main` commit: `git tag v0.0.0 && git push origin v0.0.0`.
10. Keep `package.json` publish metadata canonical for provenance:
   - `repository.url` must be exactly `https://github.com/viewportai/viewport.git`
   - `bin.vpd` must be exactly `bin/vpd.js`

## Release flow

1. Open PR with semantic commits.
2. Merge to `main` after CI green.
3. `release.yml` runs semantic-release:
   - calculates next version,
   - updates `CHANGELOG.md`, `package.json`, and `package-lock.json`,
   - creates git tag,
   - creates GitHub release,
   - publishes package to npm.
4. Validate via:
   - GitHub release/tag exists (`vX.Y.Z`),
   - npm package version appears in registry,
   - `vpd --version` from fresh global install matches.

## Local dry run

Use this before rollout changes to release config:

```bash
npx -y \
  -p semantic-release \
  -p @semantic-release/changelog \
  -p @semantic-release/commit-analyzer \
  -p conventional-changelog-conventionalcommits \
  -p @semantic-release/git \
  -p @semantic-release/github \
  -p @semantic-release/npm \
  -p @semantic-release/release-notes-generator \
  semantic-release --dry-run
```

This does not publish; it only reports what version would be released.
