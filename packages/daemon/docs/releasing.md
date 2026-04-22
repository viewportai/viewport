# Releasing and npm Publish

## Source of truth

This repo uses Changesets, not semantic-release.

1. Package metadata lives in `packages/daemon/package.json`.
2. Human-written release intent lives in `.changeset/*.md`.
3. GitHub publishes through `.github/workflows/release-packages.yml`.
4. npm auth is provided through the `NPM_TOKEN` repository secret.

## Standard flow

1. Make code changes for `@viewportai/daemon`.
2. Add or update a changeset:

```bash
npx changeset
```

3. Merge to `main` once CI is green.
4. The release workflow opens or updates the release PR with the version bump.
5. Merging that release PR publishes the package to npm and creates the tag.

## Validation

Before merging a release PR:

```bash
npm run build -w @viewportai/daemon
npm run test -w @viewportai/daemon
node packages/daemon/dist/index.js --version
```

After publish:

1. Confirm the new version exists on npm.
2. Confirm the git tag exists.
3. Confirm a fresh global install reports the same `vpd --version`.
