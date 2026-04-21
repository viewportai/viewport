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
