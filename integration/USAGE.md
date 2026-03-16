# Integration Usage

Run full end-to-end proof (server + relay + daemon native runtime + client):

```bash
cd integration
npm install
npm run test:e2e
```

Run fast smoke proof:

```bash
npm run test:smoke
```

Run regression bundle (smoke + full):

```bash
npm run test:regression
```

Run strict zero-trust assertions only (full stack + deep crypto checks):

```bash
npm run test:zero-trust
```

The harness auto-selects free local ports starting from:
- server: `7780`
- relay A: `7781`
- relay B: `7782`
- daemon: `7790`

To force specific ports:

```bash
SERVER_PORT=8780 RELAY_PORT=8781 RELAY2_PORT=8782 DAEMON_PORT=8790 npm run test:e2e
```

Optional:

```bash
PHP_BIN="$(command -v php84)" RELAY_ADMIN_TOKEN="integration-relay-admin-token" RELAY_INTERNAL_KEY="integration-relay-internal-key" npm run test:e2e
```

Disable strict zero-trust assertions temporarily (debug only):

```bash
INTEGRATION_ASSERT_ZERO_TRUST=0 npm run test:e2e
```

Run deterministic protocol conformance vectors:

```bash
npm run test:conformance
```

Run reliability scenarios:

```bash
npm run test:load
npm run test:soak
npm run test:chaos
```

Tune scenario intensity:

```bash
INTEGRATION_LOAD_CLIENTS=40 INTEGRATION_LOAD_PARALLELISM=8 npm run test:load
INTEGRATION_SOAK_MESSAGES=320 INTEGRATION_SOAK_DELAY_MS=150 npm run test:soak
```
