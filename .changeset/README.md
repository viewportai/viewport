Changesets manage package versioning in this monorepo.

Current release policy:

- `@viewportai/daemon` is the only npm package in the active public release path
- `@viewportai/protocol` and `@viewportai/client-sdk` are intentionally held back for now
- `@viewportai/relay` is ignored because it is released as a container image, not an npm package

A Changeset is a small markdown file in `.changeset/` that declares which package should be version-bumped.

Example daemon Changeset:

```md
---
"@viewportai/daemon": patch
---

Fix relay reconnect handling during daemon bootstrap.
```

Expected daemon release flow:

1. A PR that changes daemon behavior also adds a daemon Changeset file.
2. When that PR merges to `main`, the release workflow opens or updates a release PR.
3. The release PR bumps the daemon version and removes the consumed Changeset file.
4. When the release PR is merged, the release workflow publishes the new daemon version to npm.
