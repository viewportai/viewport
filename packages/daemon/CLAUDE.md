# Viewport Daemon

The daemon is the public runtime manager and CLI for coding-agent sessions.

## V0 priorities

1. keep pairing, relay connectivity, and local lifecycle reliable
2. preserve packaging/install quality
3. enforce tests before behavior changes land

## Commands

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run test:coverage
npm run verify:repo
```

## Rules

1. Favor targeted fixes over CLI churn.
2. Runtime or protocol changes require matching tests.
3. Keep install and service flows working on macOS and Linux.
