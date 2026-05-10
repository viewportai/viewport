# Protocol Vectors

These fixtures are synthetic protocol vectors for validating external
implementations. They are not customer data and are not production secrets.

Run the standalone decoder proof from the repository root:

```bash
node packages/context-engine/fixtures/protocol-vectors/standalone-decoder.mjs
```

That script intentionally imports no `@viewportai/context-engine` source modules. It
uses Node's built-in `crypto` APIs plus the documented HPKE library to prove the
decoder surface from fixture fields alone.

Cryptographic decoder vectors:

- `key-grant.json` is the legacy X25519/HKDF/AES-GCM key-grant vector. It includes
  synthetic recipient private key material so an independent decoder can unwrap the
  repo key from documented fields.
- `hpke-key-grant.json` is the canonical HPKE draft grant vector for
  `viewport.context_key_grant/hpke-draft-01`. It includes synthetic recipient HPKE
  private key material so an independent decoder can recover the 32-byte repo key
  from the suite, `enc`, ciphertext, info, and AAD fields.
- `signed-event.json` is a canonical-JSON Ed25519 event-signature vector. It omits
  the private signing key and includes the public signing key needed to verify the
  event.

Schema fixtures:

- `event.json`
- `bundle-manifest.json`
- `profile.json`
- `erase-receipt.json`

Those schema fixtures intentionally use synthetic placeholder signatures/digests
where the test target is JSON-schema shape rather than cryptographic decoding.
