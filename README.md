<p align="center">
  <img src="./assets/logo.svg" alt="Viewport" width="88" />
</p>

<h1 align="center">Viewport</h1>

<p align="center">
  Privacy-first runtime infrastructure for coding agents.
</p>

<p align="center">
  <a href="https://getviewport.com">Website</a>
  ·
  <a href="https://docs.getviewport.com">Docs</a>
  ·
  <a href="https://www.npmjs.com/package/@viewportai/daemon">npm</a>
</p>

Viewport is the open-source runtime layer behind Viewport: a daemon that runs
where your coding agents run, plus a relay that connects those machines to the
hosted or self-hosted control plane.

The daemon is the trusted edge. It supervises Claude Code, Codex, and custom
terminal-based agents; streams session state; handles pairing; and performs
local decrypt/resolve work for encrypted plans and context when configured. The
relay routes WebSocket traffic between authenticated clients and paired daemons.

Viewport is currently in alpha. The daemon and relay are usable, but product
surfaces and hosted workflows are still changing.

## What This Repo Contains

| Path | Purpose |
| --- | --- |
| [`packages/daemon`](packages/daemon) | `vpd`, the local trusted-edge daemon and CLI. |
| [`services/relay`](services/relay) | Stateless WebSocket relay for remote daemon connectivity. |
| [`integration`](integration) | End-to-end and protocol conformance harnesses. |

The hosted web app and server API live outside this open-source runtime repo.
Public product and security docs live at
[docs.getviewport.com](https://docs.getviewport.com).

## Install

For the managed alpha:

```bash
npm install -g @viewportai/daemon
vpd pair
```

`vpd pair` creates a short-lived pairing code, opens the Viewport pairing page,
and waits for you to approve the machine in the browser. After approval, the
daemon stores the workspace-scoped relay credentials in its active profile and
restarts so the machine can connect. A normal managed install creates and uses
the `prod` profile automatically; you do not need to think about profiles unless
you are also pointing the same machine at local development or staging.

Bind each repo that should stream sessions or use workspace context:

```bash
cd /path/to/repo
vpd bind .
```

`vpd bind .` writes a gitignored local binding under `.viewport/`. That binding
tells the daemon which Viewport workspace owns runs, plans, and context proposed
from that repo.

## Profiles

Fresh managed installs use `prod` automatically. Use daemon profiles directly
when one machine needs to talk to more than one Viewport environment:

```bash
vpd profile create local --copy-current --server https://api.getviewport.test --app-url https://app.getviewport.test --relay wss://relay.getviewport.test:7781/ws
vpd profile create prod --server https://api.getviewport.com --app-url https://app.getviewport.com --relay wss://relay.getviewport.com/ws
vpd profile use local
```

Each profile has separate config, auth, pairing state, keys, and relay identity
under `~/.viewport/profiles/<name>`. A repo binding records the active profile,
so a repo bound while using `local` will not stream after you switch to `prod`
until you intentionally run `vpd bind . --yes` under the prod profile.

`vpd profile use <name>` and the shorthand `vpd use <name>` change the
machine-default profile by writing `~/.viewport/current-profile`. They are not
terminal-local. For terminal-local scope, export `VPD_PROFILE`:

```bash
VPD_PROFILE=prod-user-1 vpd start --foreground
VPD_PROFILE=prod-user-2 vpd start --foreground
```

Helpful profile commands:

```bash
vpd profile env prod          # prints: export VPD_PROFILE='prod'
vpd profile start prod        # starts the prod profile daemon
vpd profile doctor prod       # checks the prod profile daemon
vpd profile ps                # lists known profile daemons
```

Multiple daemons can run at the same time when their profiles use different
listen targets. They are separate owner/supervisor processes with separate
workers and state files. Use `--listen 127.0.0.1:7071` and
`--listen 127.0.0.1:7072` when creating demo profiles that run concurrently.

Useful checks:

```bash
vpd status
vpd doctor
vpd status --json
```

Managed workflow runner checks:

```bash
vpd workflow worker --server https://api.getviewport.com --workspace <org-id> --executor <runner-id> --credential <vpexec-token> --runner-pool <pool> --doctor --json
vpd workflow worker --server https://api.getviewport.com --workspace <org-id> --executor <runner-id> --credential <vpexec-token> --runner-pool <pool>
```

The web app now issues a portable registration profile when you create or rotate
a runner credential. Write that profile to the suggested path, then run:

```bash
vpd workflow worker --registration-profile="$HOME/.viewport/managed-executors/<runner>.json" --doctor --json
vpd workflow worker --registration-profile="$HOME/.viewport/managed-executors/<runner>.json"
```

`--doctor` validates the local daemon adapters and the platform runner
credential by sending heartbeat-only proof, then exits without claiming work.
Runners are organization-scoped compute; team ownership stays on the workflow
run and artifact records selected by the control plane.

Package operations:

```bash
vpd upgrade --restart
vpd uninstall --yes
```

`vpd uninstall` removes the service and package. It only deletes daemon data
when `--purge-home` is passed.

## Fresh User Flow

1. Create a Viewport account and workspace in the web app.
2. Install the daemon: `npm install -g @viewportai/daemon`.
3. Pair the machine: `vpd pair`.
4. Approve the pairing request in the browser.
5. Bind a repo: `vpd bind .`.
6. Open Claude Code, Codex, or your custom terminal agent in that repo.

After binding, sessions can stream to Viewport when the daemon is online. Plans
created through the installed Viewport hooks can open as encrypted drafts.
Context proposals resolve against the workspace selected by the repo binding.

## Architecture

Viewport separates the runtime into three planes:

| Plane | Role |
| --- | --- |
| Trusted edge | The local or remote daemon. It owns machine-local state, agent processes, and runtime decrypt operations. |
| Relay | WebSocket transport. It routes authenticated frames and should not be treated as an application database. |
| Control plane | Identity, workspace membership, pairing approval, metadata, and policy. |

The server stores product metadata needed for collaboration. Encrypted plan and
context bodies are stored as ciphertext when using trusted-edge flows. Hosted
web can render plaintext only after a paired daemon returns it for an active,
short-lived review session.

## Local Development

Install dependencies once:

```bash
npm install
```

Run the daemon from this checkout:

```bash
npm run daemon
vpd start --foreground
```

Common checks:

```bash
npm run daemon:check
npm run relay:check
npm run daemon:install:verify
```

`npm run daemon` builds and links `@viewportai/daemon` globally, so normal
`vpd ...` commands point at this checkout until you reinstall or relink.

For package-level details, see:

- [Daemon README](packages/daemon/README.md)
- [Daemon configuration](packages/daemon/docs/configuration.md)
- [Daemon security notes](packages/daemon/docs/security.md)
- [Testing guide](packages/daemon/docs/testing.md)
- [Release checklist](packages/daemon/docs/releasing.md)

## Self-Hosting

The daemon and relay are open source. A self-hosted deployment also needs a
compatible server API/control plane for identity, pairing, workspace policy, and
metadata.

Relay example:

```bash
docker build -t viewport-relay services/relay
docker run --rm -p 7781:7781 \
  -e HOST=0.0.0.0 \
  -e RELAY_MODE=prod \
  -e SERVER_URL=https://api.example.com \
  -e RELAY_PUBLIC_WS_BASE_URL=wss://relay.example.com/ws \
  viewport-relay
```

See the self-hosting docs:
[docs.getviewport.com/self-host/overview](https://docs.getviewport.com/self-host/overview).

## Security Posture

Viewport’s strongest privacy guarantees come from keeping sensitive runtime
operations on paired trusted edges. This repo avoids claiming that hosted web is
zero-knowledge: if hosted web renders plaintext, the browser is part of the
trusted display path for that session.

The public security docs describe the current trust split and known limits:
[docs.getviewport.com/concepts/trust-and-privacy](https://docs.getviewport.com/concepts/trust-and-privacy).

## License

[Apache 2.0](LICENSE)
