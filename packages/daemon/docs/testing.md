# Daemon Testing Guide

## Layers

1. Unit tests: fast behavior checks for isolated modules.
2. Integration tests: daemon + HTTP/WS route behavior in-process.
3. Protocol e2e tests: WS command/event lifecycle with harness.
4. Fullstack net e2e: real CLI -> real daemon HTTP/WS over localhost.

## Commands

Fast confidence:

```bash
npm run check:protocol-matrix
npm run typecheck
npm run test -- tests/cli tests/server
```

Single-entry test command with modes:

```bash
npm run test
npm run test --verify
npm run test --e2e
npm run test --fullstack
npm run test --env
npm run test --service
```

Protocol e2e:

```bash
npm run test:e2e
```

Fullstack CLI proof (network bind required):

```bash
npm run test:e2e:fullstack
```

Full gate:

```bash
npm run check
```

Local environment verification:

```bash
# isolated daemon lifecycle verification (temp VIEWPORT_HOME + dedicated listen target)
npm run verify:env

# includes launchd/systemd install + active status checks
npm run verify:env:service

# validates local tarball install + binary lifecycle in isolated npm prefix
npm run verify:install
```

`verify:install` requires network access to resolve package runtime dependencies.

One-command local checker:

```bash
# repo gates only
npm run verify:repo

# repo gates + env verification + service checks
bash ./scripts/verify.sh --env --service

# repo gates + fullstack net e2e + env verification + service checks
bash ./scripts/verify.sh --fullstack --env --service
```

## CI Linux verification

GitHub Actions now runs a dedicated Linux runtime verification path:

```bash
npm run verify:linux:ci
```

This validates:
1. Tarball install verification (`verify:install`)
2. Dev install + isolated daemon lifecycle verification (`verify:env`)
3. systemd user-service verification when available on runner (`verify:env:service`)

## What fullstack e2e proves

`tests/e2e/cli-fullstack-workflow.test.ts` verifies in one workflow:

1. `vpd run` launches over real WS.
2. `vpd ls` and `vpd agent mode` hit real HTTP routes.
3. `vpd worktree diffs/summary/retry/squash` use live daemon state.
4. Pairing trust-anchor flow: offer + redeem success and mismatch rejection.
5. `vpd session stop` terminates the live session.

The test is opt-in via `VIEWPORT_RUN_NET_E2E=1` because it requires binding a localhost port.

## Dev install flows

Use local source without publishing to npm:

```bash
# tarball install flow (recommended)
./scripts/install-dev.sh --yes --no-service --no-prereqs --no-hooks

# npm link flow
./scripts/install-dev.sh --link --yes --no-service --no-prereqs --no-hooks
```
