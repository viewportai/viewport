# Viewport Operator Integration

This package runs the real cross-repo operator integration harness for the open runtime stack:

1. platform API
2. relay
3. daemon
4. real pairing approval through the current API
5. relay presence + browser relay token validation

It uses the current browser, runtime, and pairing contracts directly.

## Run

```bash
cd integration
npm install
npm run test:operator
```

More complete pass:

```bash
npm run test:e2e
```

Regression bundle:

```bash
npm run test:regression
```

Protocol vectors remain separate:

```bash
npm run test:conformance
```

## Environment

- `PLATFORM_ROOT` points at the checked-out `platform` repo. Defaults to `../platform`.
- `PHP_BIN` forces the PHP binary used for migrations and `artisan serve`.
- `SERVER_PORT`, `RELAY_PORT`, `DAEMON_PORT` override the preferred local ports.
- `RELAY_ADMIN_TOKEN` overrides the relay admin bearer token used for `/state`.
- `RELAY_INTERNAL_KEY` overrides the relay/server internal auth key.

The harness always starts the current API contract and proves these flows:

- authenticated operator can create a pairing code
- `vpd pair <code>` can claim it
- operator approval creates an install and daemon issue token
- daemon restarts onto the relay using the approved credentials
- relay presence resolves through the control plane
- browser relay token issuance validates against the relay internal API
