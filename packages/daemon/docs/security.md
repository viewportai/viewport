# Viewport Daemon Security Profiles

## Profiles

- `local`
  - Host must be loopback.
  - Auth optional.
  - Intended for single-machine use.
- `lan`
  - Requires explicit host allowlist (`--allowed-hosts` or config/env equivalent).
  - Auth required.
- `relay`
  - Requires explicit host allowlist.
  - Auth required.
  - Intended for managed or self-hosted relay-backed runtime access.

## Current controls

- Host header allowlist enforcement.
- Origin allowlist enforcement.
- Token auth (`~/.viewport/auth-token`) for protected API/WS.
- WS auth supports `?token=` query fallback only in `local` profile by default.
  - In `lan`/`relay`, query-token auth is disabled unless `VIEWPORT_ALLOW_QUERY_TOKEN_NON_LOCAL=1`.
  - Tradeoff: query tokens can leak via logs/history, so use `Authorization: Bearer ...` whenever possible.
  - Preferred path is `Authorization: Bearer ...`.
- WebSocket payload limits, backpressure handling, and rate limiting.
- Path traversal protection for file APIs.

## Pairing foundations (current phase)

- `vpd pair` creates short-lived offers (default 10 minutes, max 60 minutes).
- Offer URL contains `offerId`, one-time proof, trust-anchor fingerprint, and connection metadata, not the auth token.
- Daemon trust anchor can be inspected:
  - `vpd pair anchor`
- Offer redemption is one-time:
  - `POST /api/pair/redeem` with `offerId` + `proof` + `trustAnchor`
  - Local loopback profile can bypass bearer auth for redeem; LAN/relay profiles cannot.
- Pairing events are written to `~/.viewport/pairing-audit.jsonl`.

## Remaining hardening work

The current foundation still needs dedicated security review in these areas:

- explicit device identity lifecycle
- revocation propagation across relay sessions
- short-lived capability-token scoping by command or permission class
