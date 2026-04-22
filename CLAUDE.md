# Viewport OSS Monorepo

This repo owns the public runtime plane for Viewport.

## Scope

- daemon runtime and CLI
- relay transport
- integration and conformance harnesses

The private control plane lives in the sibling `platform` repo.

## Version 0 priorities

1. keep the public runtime reliable and well-tested
2. make the runtime easy to package and consume from the platform repo
3. make CI prove the same guarantees local contributors rely on

## Canonical commands

```bash
npm ci
npm run daemon:check
npm run relay:check
npm run integration:smoke
npm run integration:e2e
```

## Change naming

- Branch names use semantic prefixes with concise kebab-case descriptions: `feat/...`, `fix/...`, `refactor/...`, `docs/...`, `test/...`, `chore/...`.
- PR titles use semantic commit format with an optional scope: `feat(runtime): ...`, `fix(daemon): ...`, `docs(repo): ...`.
- Merge commits follow the same semantic format as PR titles.
- Do not use roadmap labels or temporary agent labels in branches or PR titles.
