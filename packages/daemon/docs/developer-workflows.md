# Developer Workflows

## Install and run locally

1. Tarball-based local install (recommended):

```bash
./scripts/install-dev.sh --yes --no-service --no-prereqs --no-hooks
```

2. `npm link` local install (use only when you specifically need symlink behavior):

```bash
./scripts/install-dev.sh --link --yes --no-service --no-prereqs --no-hooks
```

## Uninstall / reinstall locally

1. Remove global package and user service:

```bash
npm run dev:uninstall
```

2. Remove package + service + daemon home/state:

```bash
npm run dev:uninstall:all
```

3. Reinstall from current local source:

```bash
npm run dev:reinstall
```

Note on macOS background item naming:
The Login Items UI may show `Node.js Foundation` for the daemon service because launchd runs the Node runtime binary. That name comes from the executable signature, not the launchd label (`ai.viewport.daemon`).
If you ever see `sh` there, your service was installed from an older shell-wrapper plist; run `vpd service uninstall && vpd service install` to refresh it.

## Why tarball install exists

`npm pack` builds the exact package artifact that npm would publish (`@viewportai/daemon-<version>.tgz`).
Installing from that tarball verifies all of these in one path:

1. `files`/packaging manifest is correct.
2. `bin` (`vpd`) resolves correctly after install.
3. Runtime dependencies are present in the packaged artifact.
4. Real install behavior matches production npm installs.

That makes tarball install a stronger release-confidence check than `npm link`, which can hide packaging mistakes by running directly from the source tree.

## Verification scripts

1. Repository quality gate:

```bash
npm run verify:repo
```

2. Environment verification (temporary runtime config):

```bash
npm run verify:env
```

3. Environment verification + OS service checks:

```bash
npm run verify:env:service
```

4. Package/install verification from a temporary npm prefix:

```bash
npm run verify:install
```

Note: this command requires internet access to resolve package runtime dependencies.

5. Combined verification with optional flags:

```bash
./scripts/verify.sh --fullstack --env --service
```

## Unified test command modes

```bash
npm run test
npm run test --verify
npm run test --e2e
npm run test --fullstack
npm run test --env
npm run test --service
```

## Script surface (canonical)

Use only these shell entrypoints:

1. `scripts/install.sh`
2. `scripts/install-dev.sh`
3. `scripts/test.sh`
4. `scripts/test-env.sh`
5. `scripts/install-verify.sh`
6. `scripts/verify.sh`

## Linked-build workflow

Start the daemon from the repo against your existing global daemon home:

```bash
npm run daemon:start
npm run daemon:doctor
```

That path keeps one daemon model:

- global state in `~/.viewport/`
- optional project override in `.viewport/config.json`
- local repo builds activated via `npm run daemon`
- `vpd doctor` shows the active config path and whether it came from an explicit override or the nearest ancestor `.viewport/config.json`
