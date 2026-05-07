# Protocol Vectors

These fixtures are draft, synthetic protocol vectors for validating external implementations during the POC.

They are not customer data and are not production secrets. `key-grant.json` intentionally includes synthetic recipient private key material so an independent decoder can prove it can unwrap the encrypted repo key from documented fields.

Only `key-grant.json` and generated HPKE proof artifacts are cryptographic decoder vectors today. The event, manifest, profile, and erase-receipt fixtures are schema fixtures with synthetic placeholder signatures/digests. They must be replaced with true cryptographic golden vectors before a stable wire protocol release.
