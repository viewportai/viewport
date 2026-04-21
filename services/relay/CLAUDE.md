# Viewport Relay

The relay is the public WebSocket transport and routing layer for remote daemon access.

## V0 priorities

1. keep admission, routing, and security deterministic
2. preserve compatibility with the daemon bridge and integration harness
3. keep the Docker image and local startup path usable from the platform repo

## Commands

```bash
npm run build
npm run typecheck
npm run lint
npm run test
npm run check
```
