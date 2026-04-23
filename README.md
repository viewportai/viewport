# Viewport

Self-hostable orchestration and control plane for coding agents.

Viewport lets developers and teams supervise, control, and automate AI coding agents running across laptops, devboxes, and remote machines — from a browser or phone.

## System docs

The docs app in the sibling `../docs` repo is the canonical explanation of:

- hosted URL roles
- local versus managed versus self-hosted runtime shapes
- pairing and relay admission
- full-stack local development from the platform repo

## Packages

| Package | Description | Status |
|---|---|---|
| [`@viewportai/daemon`](packages/daemon) | Agent runtime manager — launches, supervises, and exposes agent sessions via HTTP/WS | Published on [npm](https://www.npmjs.com/package/@viewportai/daemon) |
| [`relay`](services/relay) | Stateless WebSocket router for remote runtime access | Docker image |

## Quick Start

### Daemon

```bash
npm install -g @viewportai/daemon
vpd setup
vpd service status
vpd status
```

`vpd setup` installs and starts the user-level boot service when you accept the recommended defaults. Run `vpd start` manually only if you skipped service install.

To attach the daemon to the managed control plane after you approve pairing in the app:

```bash
vpd remote login --server https://app.getviewport.com --workspace <workspace-id> --token <issue-token> --enable
vpd restart
```

The daemon defaults to the managed relay and control-plane topology unless you explicitly override the server or relay endpoint for local or self-hosted use.

Use `vpd pair --app-url <url>` only when the browser pairing app is hosted at a different origin than the API server. The managed defaults are:

- API server: `https://getviewport.com`
- browser app: `https://app.getviewport.com`

### Relay (self-hosted)

```bash
docker build -t viewport-relay services/relay
docker run --rm -p 7781:7781 \
  -e HOST=0.0.0.0 \
  -e RELAY_MODE=prod \
  -e SERVER_URL=https://platform.example.com \
  -e RELAY_PUBLIC_WS_BASE_URL=wss://relay.example.com/ws \
  viewport-relay
```

`SERVER_URL` and `RELAY_PUBLIC_WS_BASE_URL` are required for any non-local deployment.

## Development

```bash
npm run daemon

npm run daemon:start
npm run daemon:status
npm run daemon:doctor
npm run daemon:stop
npm run daemon:restart
npm run relay
npm run daemon:test
npm run daemon:install:verify
npm run daemon:check
npm run relay:test
npm run relay:check
```

`npm run daemon` prepares this checkout as the active global daemon build by running `npm link` for `@viewportai/daemon`. After that, normal `vpd ...` usage points at the daemon code from this repo until you relink or reinstall a different build.

Viewport uses one daemon model:

- global state lives in `~/.viewport/`
- optional project overrides live in the nearest `.viewport/config.json`

That means:

- `vpd ...` always talks to the globally linked or installed daemon
- `npm run daemon:start` runs `vpd start --foreground` against that same global home
- a local `.viewport/config.json` only overrides selected targeting values such as server, relay, and listen settings
- `npm run daemon:install:verify` exercises the packaged install path in an isolated prefix so we keep testing the real `curl | bash` story

For local-domain development, keep the runtime override in `.viewport/config.json` and stage certificates into `~/.viewport/certs` or `.viewport/certs`. The repo wrapper will promote project certs into the global daemon home when needed so restart keeps working.

`npm run relay` starts only the relay. If pairing stalls on relay reconnect, run `npm run daemon:status` and look for the `Relay state` and `Relay last` lines before digging into raw logs.

Everything else is package-local or maintainer-only and should be run from the relevant package directory rather than surfaced at the repo root.

## Contribution Naming

- Branches: `feat/...`, `fix/...`, `refactor/...`, `docs/...`, `test/...`, `chore/...`
- PR titles: semantic format with optional scope, for example `feat(runtime): ...`
- Do not use roadmap labels or temporary agent labels in branch names or PR titles.

## Architecture

Viewport has three runtime planes:

- **Control plane** — identity, workspace access, token issuance, policy (lives in a [separate private repo](https://github.com/viewportai/platform))
- **Runtime plane** — daemon-owned session authority, permissions, agent lifecycle
- **Data plane** — relay-mediated transport for remote connectivity

The daemon runs on the machine where your agents run. The relay routes WebSocket traffic between daemons and clients. The control plane manages identity, workspaces, and policy.

## Self-Hosting

Viewport is designed to be self-hosted. The daemon and relay are open source. You can run the full runtime stack on your own infrastructure without depending on any hosted service.

## License

[Apache 2.0](LICENSE)
