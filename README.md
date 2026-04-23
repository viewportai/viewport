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
# Install dependencies
npm ci

# Run the daemon in the foreground
npm run daemon

# Inspect daemon identity and runtime state
npm run daemon:status
npm run daemon:doctor

# Stop or restart the daemon
npm run daemon:stop
npm run daemon:restart

# Run relay in dev mode
npm run relay

# Test and check each component
npm run daemon:test
npm run relay:test
npm run daemon:check
npm run relay:check
```

Full integration flows are operator-only surfaces:

```bash
npm run ops:integration:operator
npm run ops:integration:e2e
```

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
