# Viewport Daemon Configuration

This page is package-local reference for daemon developers and operators. The
public setup docs live at <https://docs.getviewport.com>.

## Precedence

Daemon home resolution happens before config loading:

1. Base home defaults to `~/.viewport`.
2. `VIEWPORT_HOME`, `VPD_HOME`, or top-level `vpd --home <path> ...` change the
   base home.
3. `VPD_PROFILE`, `VIEWPORT_PROFILE`, or top-level `vpd --profile <name> ...`
   select `profiles/<name>` under that base home.
4. If no environment profile is set, `vpd profile use <name>` selects the
   current profile stored in `<base-home>/current-profile`.

The resolved daemon home contains `config.json`, `auth-token`, pairing state,
keys, relay identity, and local runtime stores.

Daemon runtime settings resolve inside the selected home in this order (later wins):

1. Built-in defaults
2. `<selected-home>/config.json` (`daemon.*`)
3. Environment variables (`VIEWPORT_*`)
4. CLI flags

Session config resolution is separate:

1. Framework built-ins
2. Agent defaults
3. Global defaults (`defaults`)
4. Directory overrides (`directories.<id>.config`)
5. Session launch overrides

## Runtime keys

`config.json`:

```json
{
  "daemon": {
    "listen": "127.0.0.1:7070",
    "profile": "local",
    "allowedHosts": ["localhost"],
    "allowedOrigins": ["localhost"],
    "authEnabled": false,
    "logFile": "~/.viewport/daemon.log",
    "relay": {
      "enabled": false,
      "endpoint": "wss://relay.getviewport.com/ws",
      "serverUrl": "https://api.getviewport.com",
      "workspaceId": "workspace_demo",
      "issueToken": "install_daemon_issue_...",
      "tlsVerify": "auto",
      "caCertPath": "/path/to/relay-ca.pem",
      "tlsPins": ["ab12cd34..."],
      "tokenIssuer": "getviewport-runtime",
      "tokenAudience": "viewport-relay",
      "tokenClockSkewSec": 30
    }
  }
}
```

Optional pairing-browser override:

```json
{
  "daemon": {
    "server": {
      "url": "https://api.getviewport.com",
      "appUrl": "https://app.getviewport.com"
    }
  }
}
```

Use `appUrl` only when the browser pairing app is intentionally hosted at a different origin than the API server. For the managed topology:

- API server: `https://api.getviewport.com`
- browser app: `https://app.getviewport.com`

## Environment variables

- `VIEWPORT_HOME` / `VPD_HOME`
- `VPD_PROFILE` / `VIEWPORT_PROFILE` (daemon environment profile)
- `VIEWPORT_LISTEN`
- `VPD_RUNTIME_PROFILE` / `VIEWPORT_RUNTIME_PROFILE` (`local|lan|relay`) for daemon network exposure mode.
- `VIEWPORT_ALLOWED_HOSTS`
- `VIEWPORT_ALLOWED_ORIGINS`
- `VIEWPORT_AUTH`
- `VIEWPORT_LOG_FILE`
- `VIEWPORT_SERVER_URL` / `VPD_SERVER_URL`
- `VIEWPORT_APP_URL` / `VPD_APP_URL`
- `VIEWPORT_RELAY_ENABLED`
- `VIEWPORT_RELAY_ENDPOINT`
- `VIEWPORT_RELAY_SERVER`
- `VIEWPORT_RELAY_WORKSPACE`
- `VIEWPORT_RELAY_ISSUE_TOKEN`
- `VIEWPORT_RELAY_TLS_VERIFY` (`auto|0|1`)
- `VIEWPORT_RELAY_CA_CERT`
- `VIEWPORT_RELAY_TLS_PINS` (comma-separated SHA-256 cert fingerprints)
- `VIEWPORT_RELAY_TOKEN_ISSUER`
- `VIEWPORT_RELAY_TOKEN_AUDIENCE`
- `VIEWPORT_RELAY_TOKEN_SIGNING_KEYS_JSON`
- `VIEWPORT_RELAY_TOKEN_CLOCK_SKEW_SEC`
- `VIEWPORT_HTTP_LOG_LEVEL`
- `VIEWPORT_MAX_WS_CLIENTS`

## CLI flags

- Top-level `--home <path>`
- Top-level `--profile <name>` for daemon environment selection
- `--listen`
- `start --profile local|lan|relay` for network exposure mode
- `--allowed-hosts`
- `--allowed-origins`
- `--auth`
- `--log-file`
- `--relay`
- `--relay-endpoint`
- `--relay-server`
- `--relay-workspace`
- `--relay-issue-token`
- `--relay-tls-verify`
- `--relay-ca-cert`
- `--relay-tls-pins`
- `--relay-token-issuer`
- `--relay-token-audience`
- `--relay-token-signing-keys-json`
- `--relay-token-clock-skew-sec`
- `--no-relay`

Pairing-only flags:

- `--server`
- `--app-url`

## Profiles

`vpd setup` creates and selects the managed `prod` profile on a fresh install.
Users installing the daemon for the hosted product do not need to run profile
commands manually.

Create profiles for each environment:

```bash
vpd profile create local --copy-current --server https://api.getviewport.test --app-url https://app.getviewport.test --relay wss://relay.getviewport.test:7781/ws
vpd profile create prod --server https://api.getviewport.com --app-url https://app.getviewport.com --relay wss://relay.getviewport.com/ws
vpd profile use prod
```

`vpd profile use <name>` writes the machine-default profile to
`~/.viewport/current-profile`. It is shared by future CLI commands, but it does
not retarget daemons that are already running. Use these forms for temporary
scope:

```bash
eval "$(vpd profile env prod)"
VPD_PROFILE=prod vpd status
vpd --profile prod status
vpd profile start prod
vpd profile doctor prod
```

Multiple running daemons require distinct listen targets:

```bash
vpd profile create alice --server https://api.getviewport.com --app-url https://app.getviewport.com --relay wss://relay.getviewport.com/ws --listen 127.0.0.1:7071
vpd profile create bob --server https://api.getviewport.com --app-url https://app.getviewport.com --relay wss://relay.getviewport.com/ws --listen 127.0.0.1:7072
vpd profile start alice
vpd profile start bob
vpd profile ps
```

Each profile uses its own `daemon-state.json`, so concurrent profiles are
separate owner/supervisor processes with separate workers, credentials, key
stores, and relay connections. Repo streaming is checked against the daemon's
startup profile, not the mutable machine-default profile.

Profile homes:

```text
~/.viewport/
  profiles.json
  current-profile
  profiles/
    local/
      config.json
      auth-token
      ...
    prod/
      config.json
      auth-token
      ...
```

Repo bindings record the active profile in `.viewport/local.yaml`:

```yaml
version: 1
organization_id: 01...
profile: prod
remote:
  stream: enabled
```

Relay streaming requires the organization and profile to match. Switching from
`local` to `prod` does not cause local-bound repos to stream to production until
you intentionally re-run `vpd bind . --yes` under `prod`.

## Relay bootstrap

- Configure relay credentials:

```bash
vpd remote login --server https://api.getviewport.com --workspace workspace_demo --token <issue-token> --enable
```

- `--token` should be the daemon issue token the control plane returns after pairing approval.
- Apply updates with:

```bash
vpd restart
```

## Validation guarantees

- `~/.viewport/config.json` is schema-validated with Zod.
- Malformed JSON or schema-invalid values fail fast with actionable errors.
- Unknown keys are rejected to prevent silent misconfiguration drift.

## Relay pressure defaults

The native relay runtime is bounded even before custom tuning:

- max pending outbound messages: `500`
- max pending outbound bytes: `4 MiB`
- replay acceptance window: `1024` sequence numbers
- key-rotation threshold: `250` encrypted messages per session
- idle relay-session TTL inside daemon bridge: `15 minutes`

Recommended starting points:

- local/dev: keep defaults
- single-tenant self-host: keep defaults, set `tokenIssuer`, `tokenAudience`, and `signingKeys`
- managed production: enforce `tlsPins`, explicit signing-key set, and rotate cert pins with overlap windows
