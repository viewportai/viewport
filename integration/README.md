# Viewport Integration E2E

Runs a real local stack:

1. Laravel issuing server (`server`)
2. Relay service (`relay`)
3. Daemon (`daemon`)
4. Daemon native relay runtime (no external bridge process)
5. Encrypted client over relay (inside test harness)

## Run

```bash
cd integration
npm install
npm run test:regression
```

Fast loops:

```bash
npm run test:smoke
npm run test:e2e
npm run test:zero-trust
npm run test:conformance
npm run test:load
npm run test:load:server
npm run test:load:redis
npm run test:soak
npm run test:soak:server
npm run test:soak:redis
npm run test:chaos
npm run test:backplane:single
npm run test:backplane:server
npm run test:backplane:redis
```

Optional envs:

- `PHP_BIN` to force the PHP binary used for server migrations/serve (defaults to `php84` when available).
- `RELAY_ADMIN_TOKEN` to override the relay admin token used for `/state` and `/logs` diagnostics.
- `RELAY_INTERNAL_KEY` to override relay/server internal presence-control auth.
- `RELAY2_PORT` to override the secondary relay instance port (multi-relay sticky test).
- `INTEGRATION_BACKPLANE_MODE` to force `single`, `server`, or `redis` outside the explicit backplane scripts.
- `INTEGRATION_DUAL_RELAY=0|1` to force single-relay or dual-relay topology for load/soak runs.
- `INTEGRATION_LOAD_CLIENTS` / `INTEGRATION_LOAD_PARALLELISM` for load scenario shape.
- `INTEGRATION_SOAK_MESSAGES` and `INTEGRATION_SOAK_DELAY_MS` for long-running rekey soak pacing.

This verifies:

- Policy A/B/C behavior
- Deterministic conformance vectors for `noise-ik` and `noise-ikpsk2`
- Multi-relay workspace routing with redirect hint + cross-relay bus forwarding
- Real daemon response via relay path
- Load validation with concurrent encrypted clients
- Soak validation across key-rotation threshold and rekey
- Chaos validation for relay-node termination and client recovery
- Relay does not surface plaintext message payloads
- Server never issues runtime decrypt key material (`e2eeKey`)
- Plaintext relay injection is rejected (no daemon ack)
- Tampered ciphertext/tag is rejected (AEAD auth failure)
- Bus rows contain only envelope/control-frame data (no runtime plaintext)
