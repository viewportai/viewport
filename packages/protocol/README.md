# @viewportai/protocol

Status: private Batch A contract package.

This package is the source of truth for protocol schema ids, canonical samples,
and compatibility fixture checks. It does not make target-only contracts
production-ready.

## Implemented Today

- `viewport.workflow/v1`
- repo config `schema: viewport.repo_config/v1` plus daemon-compatible `version: 1`

These are validated against the existing daemon validators. The repo config
schema id is a Batch A protocol overlay accepted by the daemon passthrough
parser. `viewport.workflow/v1` is also validated against the platform
`workflow-core` validator when this repo is checked out beside `platform`.

## Target-Only

The route, execution profile, runner workspace, context package, agent event,
evidence, action proposal, approval decision, context receipt, and audit receipt
samples are intentionally target-only. They establish naming, casing, and sample
shape for review before storage, runtime, and UI behavior are implemented.

## Commands

```bash
npm run validate:samples -w @viewportai/protocol
npm run test -w @viewportai/protocol
npm run typecheck -w @viewportai/protocol
```

## Batch A Boundary

This package may add contracts, samples, fixture checks, and compatibility status.
It must not add migrations, customer-visible runtime behavior, provider side
effects, or public product claims.
