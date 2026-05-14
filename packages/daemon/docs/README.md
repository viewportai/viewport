# Daemon Docs

These notes are package-local reference material for `@viewportai/daemon`.
Customer-facing docs live at <https://docs.getviewport.com>.

## Files

| File | Purpose |
| --- | --- |
| [`configuration.md`](configuration.md) | Runtime config shape, precedence, and environment variables. |
| [`security.md`](security.md) | Local/LAN/relay security profile notes and pairing controls. |
| [`testing.md`](testing.md) | Test layers and verification commands. |
| [`releasing.md`](releasing.md) | Maintainer release checklist. |
| [`protocol-matrix.json`](protocol-matrix.json) | Machine-readable command coverage matrix used by CI checks. |
| [`test-vectors/`](test-vectors/) | Deterministic public crypto fixtures for conformance tests. |

The test-vector files intentionally contain synthetic private keys and session
keys. They are public deterministic fixtures only, not runtime credentials.
