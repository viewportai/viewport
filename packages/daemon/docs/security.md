# Viewport Daemon Security Profiles

This is daemon-local engineering documentation. Public security posture and
trust-boundary docs live at <https://docs.getviewport.com/concepts/trust-and-privacy>.

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
- Token auth (`~/.viewport/auth-token`) for protected local API/WS.
- WS auth supports `?token=` query fallback only in `local` profile by default.
  - In `lan`/`relay`, query-token auth is disabled unless `VIEWPORT_ALLOW_QUERY_TOKEN_NON_LOCAL=1`.
  - Tradeoff: query tokens can leak via logs/history, so use `Authorization: Bearer ...` whenever possible.
  - Preferred path is `Authorization: Bearer ...`.
- WebSocket payload limits, backpressure handling, and rate limiting.
- Path traversal protection for file APIs.

## Pairing foundations

- `vpd pair` creates short-lived offers (default 10 minutes, max 60 minutes).
- Offer URL contains `offerId`, one-time proof, trust-anchor fingerprint, and connection metadata, not the auth token.
- Daemon trust anchor can be inspected:
  - `vpd pair anchor`
- Offer redemption is one-time:
  - `POST /api/pair/redeem` with `offerId` + `proof` + `trustAnchor`
  - Local loopback profile can bypass bearer auth for redeem; LAN/relay profiles cannot.
- Pairing events are written to `~/.viewport/pairing-audit.jsonl`.

## Notes and limits

The daemon is a trusted edge. If a local machine or browser session is
compromised, Viewport cannot prevent plaintext exposed to that machine from
being read. Team sharing uses soft revocation for already-synced plaintext:
future material can be rotated or withheld, but previously decrypted local data
cannot be made unread.
