# @viewportai/context-engine

Canonical Context Vault engine for encrypted-edge context.

This package is intentionally package-local CommonJS while the standalone POC is being landed into the Viewport monorepo. The daemon should depend on this package instead of reimplementing context encryption, event storage, materialization, candidate gating, profile resolution, or bundle manifest logic.

## Boundary

- Stable event schema: `viewport.context_event/v1`
- Stable bundle manifest schema: `viewport.context_bundle_manifest/v1`
- Server sync is still disabled until platform ciphertext-only guards and external protocol review exist.
- Device-local private material is still file-backed in this engine; OS keychain / Secure Enclave storage is a separate hardening PR.

## Threat / Test Map

| Threat or claim | Proof |
| --- | --- |
| Context bodies are encrypted in sync events | `crypto-envelope.test.js`, `private-context.test.js`, `shared-context-sync.test.js` |
| Wrong recipient cannot unwrap shared context | `crypto-envelope.test.js`, `hpke-grants.test.js` |
| Tampered grants or envelopes are rejected | `crypto-envelope.test.js`, `hpke-grants.test.js`, `protocol-schemas.test.js` |
| Untrusted agent/tool output cannot bypass candidate review | `poisoning-guard.test.js`, `candidate-workflow.test.js` |
| Revocation blocks future access while old plaintext remains an explicit limitation | `key-rotation.test.js`, `team-scale-revocation.test.js`, `user-device-access.test.js` |
| New approved user device can read existing project history without project-level rewrap | `user-device-access.test.js` |
| User-owned events are signed by approved devices instead of a plaintext identity shadow | `user-device-access.test.js` |
| User private key material is absent from exported encrypted sync events | `user-device-access.test.js` |
| Any authorized peer can fulfill a missing user grant | `access-model.test.js` |
| Missing grants are key-delivery-pending, not silently denied | `access-model.test.js` |
| Resolver/profile drift is refused unless an override is recorded | `resolver-pins.test.js`, `profile-registry.test.js` |
| Bundle manifests are reproducible and cite selected context | `bundle-resolution.test.js`, `protocol-vectors.test.js` |
| Offline local resolution avoids remote plaintext calls | `offline-bundle.test.js`, `local-semantic-retrieval.test.js` |
| Cooperative erase is a signed compliance receipt, not a cryptographic claw-back | `cooperative-erase.test.js` |

This map is not a replacement for the full threat model in `plan/context/`; it is the package-level release checklist for engine behavior.
