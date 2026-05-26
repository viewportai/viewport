# Releasing and npm Publish

## Scope

This document is intentionally narrow: it describes release validation for `@viewportai/daemon`, not the repo's package-versioning policy.

Feature PRs should not carry release metadata unless the goal of the PR is to cut a package release.

Package metadata lives in `packages/daemon/package.json`. Publishing is performed through the repo's current release workflow on `main` with the repository `NPM_TOKEN` secret.

`NPM_TOKEN` must be an npm automation token with publish access to `@viewportai/daemon`. If the release workflow fails at `npm whoami` with `E401 Unauthorized`, the workflow did run; npm rejected the configured token. Rotate the repository secret, then rerun the failed `Release Packages` workflow or dispatch it manually on `main`.

## Release checklist

Before maintainers publish:

1. Merge the intended daemon changes to `main`.
2. Confirm the repo's current release workflow is the one you intend to use.
3. Confirm npm auth is configured through the repository secret.
4. Confirm the latest `Release Packages` run reached `Semantic release daemon`; if it failed earlier at npm auth, rotate `NPM_TOKEN` before retrying.

## Validation

Before publish:

```bash
npm run build -w @viewportai/daemon
npm run test -w @viewportai/daemon
node packages/daemon/dist/index.js --version
```

After publish:

1. Confirm the new version exists on npm.
2. Confirm the git tag exists.
3. Confirm a fresh global install reports the same `vpd --version`.
