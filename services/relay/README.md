# Relay

Viewport relay is the deployable WebSocket broker for remote runtime access.

## Local development

```bash
npm ci
npm run check
npm run dev
```

Important envs:

- `RELAY_BACKPLANE_MODE=single|server|redis`
- `SERVER_URL=http(s)://...`
- `RELAY_PUBLIC_WS_BASE_URL=ws(s)://.../ws`
- `RELAY_ADMIN_TOKEN=...`
- `RELAY_INTERNAL_KEY=...` for `server` and `redis`
- `RELAY_BUS_HMAC_KEY=...` when cross-relay bus is enabled
- `RELAY_REDIS_URL=redis://...` for `redis`

Mode defaults:

- `single`: single relay, no redirect, no cross-relay bus
- `server`: multi-relay using server internal APIs for presence + bus
- `redis`: multi-relay using Redis for presence + bus
- `RELAY_MODE` defaults to `dev` only for loopback/local endpoints; any non-local deployment defaults to `prod` hardening unless you explicitly override it

Canonical local helper (from monorepo root):

```bash
npm run relay
RELAY_BACKPLANE_MODE=redis RELAY_REDIS_URL=redis://127.0.0.1:6379 npm run relay
```

## Deployment

Relay is deployed as a containerized service, not published as an npm package.

```bash
docker build -t viewport-relay .
docker run --rm -p 7781:7781 \
  -e HOST=0.0.0.0 \
  -e PORT=7781 \
  -e RELAY_MODE=prod \
  -e RELAY_BACKPLANE_MODE=single \
  -e SERVER_URL=https://app.getviewport.com \
  -e RELAY_ADMIN_TOKEN=change-me \
  -e RELAY_INTERNAL_KEY=change-me-change-me-change-me \
  -e RELAY_SERVER_MTLS=1 \
  -e RELAY_SERVER_TLS_VERIFY=1 \
  -e RELAY_SERVER_CLIENT_CERT_PATH=/run/secrets/relay-client.crt \
  -e RELAY_SERVER_CLIENT_KEY_PATH=/run/secrets/relay-client.key \
  -e RELAY_PUBLIC_WS_BASE_URL=wss://relay.getviewport.com/ws \
  viewport-relay
```

Redis-backed staging example:

```bash
docker run --rm -p 7781:7781 \
  -e HOST=0.0.0.0 \
  -e PORT=7781 \
  -e RELAY_MODE=prod \
  -e RELAY_BACKPLANE_MODE=redis \
  -e SERVER_URL=https://app.getviewport.com \
  -e RELAY_ADMIN_TOKEN=change-me \
  -e RELAY_INTERNAL_KEY=change-me \
  -e RELAY_SERVER_MTLS=1 \
  -e RELAY_SERVER_TLS_VERIFY=1 \
  -e RELAY_SERVER_CLIENT_CERT_PATH=/run/secrets/relay-client.crt \
  -e RELAY_SERVER_CLIENT_KEY_PATH=/run/secrets/relay-client.key \
  -e RELAY_BUS_HMAC_KEY=change-me \
  -e RELAY_REDIS_URL=redis://redis.internal:6379 \
  -e RELAY_PUBLIC_WS_BASE_URL=wss://relay.getviewport.com/ws \
  viewport-relay
```

This repo intentionally keeps docs minimal. Full operational and product docs should live in the dedicated docs repo.
