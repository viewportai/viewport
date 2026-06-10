# Secret scanning (SEC-02)

A CI gate scans every push to `main` and every pull request for committed
secrets using [gitleaks](https://github.com/gitleaks/gitleaks). If a real secret
is committed, the **Secret scan** check fails and blocks the merge.

## Components

| File | Purpose |
| --- | --- |
| `.github/workflows/secret-scan.yml` | Installs and runs the gitleaks binary on push + PR. Minimal permissions (`contents: read`). |
| `.gitleaks.toml` | Extends the gitleaks default ruleset and adds a **tight** allowlist for known-safe matches. |

The workflow runs the gitleaks **binary** directly (not `gitleaks/gitleaks-action@v2`),
because that Action requires a paid `GITLEAKS_LICENSE` for organization-owned
repos. The gitleaks binary itself is MIT-licensed and free. On a pull request the
workflow scans only the PR commit range (`base..head`); on push to `main` it
scans the full history.

## The allowlist

The allowlist is intentionally narrow — it allowlists specific paths for test
fixtures and deterministic protocol vectors, never blanket-disables a rule.
Current entries:

- `services/relay/tests/**` — relay tests with fake `relay-internal-key-*` and
  `relay_internal_prod_secret_*` fixtures.
- `packages/daemon/tests/**` — daemon relay-bridge tests with
  `test-relay-signing-key-*` fixtures.
- `packages/context-engine/fixtures/**` — HPKE / key-grant conformance fixtures
  (deterministic test vectors, including a fake `-----BEGIN PRIVATE KEY-----`).
- `packages/daemon/docs/*conformance-vectors.json` — Noise handshake conformance
  vectors (deterministic test data, not real secrets).

When you add a new test fixture that trips gitleaks, prefer an inline
[`gitleaks:allow`](https://github.com/gitleaks/gitleaks#gitleaksallow) comment on
the line, or extend the allowlist with a specific path/regex and a comment
explaining why the match is safe.

## Verify the gate actually fails (planted-secret test)

```sh
# 1. Plant a real-looking secret in a scratch file (NOT in the repo tree).
#    Built at runtime so no Stripe-pattern literal is ever stored in the repo.
printf 'stripe_live = "sk_%s_%s"\n' live "$(openssl rand -hex 12)" > /tmp/leak-test.txt

# 2. Run gitleaks with the repo config.
gitleaks detect --no-git --source /tmp --config .gitleaks.toml -v
#    -> "leaks found: 1", RuleID: stripe-access-token, exit code 1.

# 3. Confirm the clean tree passes.
gitleaks detect --config .gitleaks.toml -v
#    -> "no leaks found", exit code 0.

# 4. Delete the scratch file. Never commit a real-looking secret.
rm /tmp/leak-test.txt
```
