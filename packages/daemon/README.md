# Viewport Daemon

Runtime supervision and orchestration layer for AI coding agents.

## What it does

1. Launches and manages agent sessions.
2. Tracks lifecycle, permissions, and session state.
3. Exposes local HTTP and WebSocket APIs for control and monitoring.
4. Supports discovery and resume flows for existing sessions.

## Requirements

1. Node.js 20+
2. npm 10+

## One Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/viewportai/viewport/main/packages/daemon/scripts/install.sh | bash
```

This installs `@viewportai/daemon` globally, then runs `vpd setup`.

Local development install (from this repo, no npm publish needed):

```bash
./scripts/install-dev.sh --yes --no-service --no-prereqs --no-hooks
```

Local development link mode:

```bash
./scripts/install-dev.sh --link --yes --no-service --no-prereqs --no-hooks
```

Link mode is for active daemon development when you want the repo checkout to become the global `vpd` binary. For release-confidence validation, prefer the tarball path through `npm run verify:install`.

Local uninstall/reinstall:

```bash
npm run dev:uninstall       # removes global package + launchd/systemd user service
npm run dev:uninstall:all   # also removes daemon home/state
npm run dev:reinstall
```

## Quick start

```bash
npm ci
npm run build
npm run test
npm run check
```

Flag-driven test entry (single command surface):

```bash
npm run test                  # unit suite (default)
npm run test --verify        # setup/service-focused verification suite
npm run test --e2e           # protocol e2e suite
npm run test --fullstack     # localhost fullstack CLI e2e
npm run test --env           # local environment verification
npm run test --service       # local environment + service verification
```

First-run onboarding:

```bash
vpd setup
```

Non-interactive recommended defaults:

```bash
vpd setup --yes
```

Custom choices:

```bash
vpd setup --choose
```

## CLI

```bash
npm run build
node dist/index.js --help
```

Boot service setup (user-level):

```bash
vpd service install
vpd service status
```

Linux VPS note:
For user-level systemd service auto-start after reboot, enable linger once:

```bash
sudo loginctl enable-linger "$USER"
```

## Profiles

Profiles isolate daemon environments on one machine. Use them when switching
between local development and production, or when demoing multiple users from
separate terminals.

Fresh managed installs create and select `prod` during `vpd setup`, so ordinary
users can install and pair without learning this command surface.

```bash
vpd profile create local --copy-current --server https://api.getviewport.test --app-url https://app.getviewport.test --relay wss://relay.getviewport.test:7781/ws
vpd profile create prod --server https://api.getviewport.com --app-url https://app.getviewport.com --relay wss://relay.getviewport.com/ws
vpd profile use prod
vpd profile status
```

Profile state lives in `~/.viewport/profiles/<name>`. That includes the config,
auth token, pairing state, keys, relay identity, and runtime stores. The base
`~/.viewport` home keeps only the profile registry and current-profile pointer
once you move to named profiles.

Temporary scope:

```bash
VPD_PROFILE=prod vpd status
vpd --profile prod status
```

`vpd start --profile local|lan|relay` still controls the daemon network
exposure mode. Put daemon profile flags before the command, or use
`VPD_PROFILE`, to avoid ambiguity.

Repo bindings include the active profile:

```bash
cd /path/to/repo
vpd bind .
```

The generated `.viewport/local.yaml` is gitignored and includes
`profile: <name>`. Relay streaming is allowed only when both the organization
and active daemon profile match. This prevents a repo bound in local development
from accidentally streaming to production after `vpd profile use prod`.

## Quality gates

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run check
```

## Testing Setup Flow

```bash
# fast setup-related tests
npm run test:setup

# full repository quality gate
npm run check

# manual verification test (no service or package installs)
VIEWPORT_HOME="$(mktemp -d)" vpd setup --yes --no-service --no-prereqs --no-hooks

# full local environment verification (temporary config dir + dedicated listen target)
npm run verify:env

# include OS service checks (launchd/systemd)
npm run verify:env:service

# package/install verification from local tarball in a temporary npm prefix
npm run verify:install

# one-command verification gate
npm run verify:repo

# CI-aligned Linux verification path
npm run verify:linux:ci
```

## Repository standards

1. Semantic commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
2. One logical change per commit.
3. Changes to protocol or runtime behavior require matching tests.
4. Branch names use semantic prefixes with concise kebab-case descriptions (`feat/...`, `fix/...`, `docs/...`).
5. PR titles use semantic commit format with an optional scope (`feat(runtime): ...`, `fix(daemon): ...`).
6. Do not use roadmap labels or temporary agent labels in branches or PR titles.

## Release

This package publishes as `@viewportai/daemon`.

Package release mechanics are maintainer-owned. Feature PRs should stay focused on code, tests, and docs unless the PR is explicitly intended to cut a package release.

When a release is intentionally being prepared, use the repo's current publish workflow from `main` and validate the built CLI before shipping.

Runtime config follows one simple rule:

- global defaults live in `~/.viewport/config.json`
- the nearest project `.viewport/config.json` can override selected daemon targets like server or relay
- `vpd doctor` will tell you whether that override was chosen explicitly or simply because it was the nearest ancestor config
- environment variables and CLI flags are temporary overrides, not the normal runtime model

See [docs/releasing.md](./docs/releasing.md) for setup and operations.
See [docs/testing.md](./docs/testing.md) and [docs/developer-workflows.md](./docs/developer-workflows.md) for local validation workflows.
