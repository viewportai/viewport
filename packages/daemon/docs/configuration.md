# Viewport Daemon Configuration

## Precedence

Daemon runtime settings resolve in this order (later wins):

1. Built-in defaults
2. `~/.viewport/config.json` (`daemon.*`)
3. Environment variables (`VPD_*` / `VIEWPORT_*`)
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
      "endpoint": "wss://relay.example.test/ws",
      "serverUrl": "https://api.example.test",
      "workspaceId": "workspace_demo",
      "enrollToken": "workspace_enroll_...",
      "tlsVerify": "auto",
      "caCertPath": "/path/to/relay-ca.pem",
      "tlsPins": ["ab12cd34..."],
      "tokenIssuer": "viewport-server-poc",
      "tokenAudience": "viewport-relay",
      "signingKeys": {
        "v1": "replace-me"
      },
      "tokenClockSkewSec": 30
    }
  }
}
```

## Environment variables

- `VPD_LISTEN` / `VIEWPORT_LISTEN`
- `VPD_PROFILE` / `VIEWPORT_PROFILE`
- `VPD_ALLOWED_HOSTS` / `VIEWPORT_ALLOWED_HOSTS`
- `VPD_ALLOWED_ORIGINS` / `VIEWPORT_ALLOWED_ORIGINS`
- `VPD_AUTH` / `VIEWPORT_AUTH`
- `VPD_LOG_FILE` / `VIEWPORT_LOG_FILE`
- `VPD_RELAY_ENABLED` / `VIEWPORT_RELAY_ENABLED`
- `VPD_RELAY_ENDPOINT` / `VIEWPORT_RELAY_ENDPOINT`
- `VPD_RELAY_SERVER` / `VIEWPORT_RELAY_SERVER`
- `VPD_RELAY_WORKSPACE` / `VIEWPORT_RELAY_WORKSPACE`
- `VPD_RELAY_ENROLL_TOKEN` / `VIEWPORT_RELAY_ENROLL_TOKEN`
- `VPD_RELAY_TLS_VERIFY` / `VIEWPORT_RELAY_TLS_VERIFY` (`auto|0|1`)
- `VPD_RELAY_CA_CERT` / `VIEWPORT_RELAY_CA_CERT`
- `VPD_RELAY_TLS_PINS` / `VIEWPORT_RELAY_TLS_PINS` (comma-separated SHA-256 cert fingerprints)
- `VPD_RELAY_TOKEN_ISSUER` / `VIEWPORT_RELAY_TOKEN_ISSUER`
- `VPD_RELAY_TOKEN_AUDIENCE` / `VIEWPORT_RELAY_TOKEN_AUDIENCE`
- `VPD_RELAY_TOKEN_SIGNING_KEYS_JSON` / `VIEWPORT_RELAY_TOKEN_SIGNING_KEYS_JSON`
- `VPD_RELAY_TOKEN_CLOCK_SKEW_SEC` / `VIEWPORT_RELAY_TOKEN_CLOCK_SKEW_SEC`
- `VIEWPORT_HTTP_LOG_LEVEL`
- `VIEWPORT_MAX_WS_CLIENTS`

## CLI flags

- `--listen`
- `--profile`
- `--allowed-hosts`
- `--allowed-origins`
- `--auth`
- `--log-file`
- `--relay`
- `--relay-endpoint`
- `--relay-server`
- `--relay-workspace`
- `--relay-enroll-token`
- `--relay-tls-verify`
- `--relay-ca-cert`
- `--relay-tls-pins`
- `--relay-token-issuer`
- `--relay-token-audience`
- `--relay-token-signing-keys-json`
- `--relay-token-clock-skew-sec`
- `--no-relay`

## Relay bootstrap

- Configure relay credentials:

```bash
vpd remote login --server https://getviewport.test --workspace workspace_demo --token <enroll-token> --enable
```

- If `--token` is omitted, the command can auto-rotate (or auto-enroll with `--user`) by calling the server API.
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
