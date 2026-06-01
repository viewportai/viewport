# Viewport Managed Runner E2B Template

Builds a sandbox image with `vpd` preinstalled. Runtime sandboxes receive only
per-run bootstrap JSON and ephemeral credentials; long-lived credentials must not
be baked into this image.

```bash
E2B_API_KEY=... npx @e2b/cli@latest template create viewport-vpd-02511-dev \
  --path services/managed-runner/e2b-template \
  --dockerfile e2b.Dockerfile \
  --cpu-count 2 \
  --memory-mb 2048 \
  --ready-cmd 'vpd --help >/dev/null'
```
