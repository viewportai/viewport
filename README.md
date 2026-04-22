# Viewport

Self-hostable orchestration and control plane for coding agents.

Viewport lets developers and teams supervise, control, and automate AI coding agents running across laptops, devboxes, and remote machines — from a browser or phone.

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

### Relay (self-hosted)

```bash
docker build -t viewport-relay services/relay
docker run --rm -p 7781:7781 \
  -e HOST=0.0.0.0 \
  -e SERVER_URL=https://platform.example.com \
  -e RELAY_PUBLIC_WS_BASE_URL=wss://relay.example.com/ws \
  viewport-relay
```

`SERVER_URL` and `RELAY_PUBLIC_WS_BASE_URL` are required for any non-local deployment.

## Development

```bash
# Install dependencies
npm ci

# Run daemon in dev mode
npm run dev -w @viewportai/daemon

# Run relay in dev mode
npm run dev -w @viewportai/relay

# Run quality gates
npm run daemon:check
npm run relay:check
```

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
