# GatewayProvider Shim

Apache-2.0 interface and reference adapters for LLM gateway executors.

Viewport product code must depend on `GatewayProvider`, not on LiteLLM,
Bifrost, Portkey, or a native proxy directly. A backend is swappable when its
adapter passes the conformance suite in `src/conformance`.
