# mcp-orc-rust

`mcp-orc-rust` is the Rust MCP orchestration runtime used by this repo today.

## Current state

- `Dockerfile.mcp-orc-rust` builds the MCP runtime image used for core and user
  MCP servers.
- The image installs the Rust `mcpo` compatibility binary (`mcp-orc`) and the
  native control plane.
- Runtime selection is fixed to the Rust path. Stale mode variables are ignored
  by setup and generation code.
- `rust-full` is the only supported orchestration mode.

## What is implemented

- Cargo workspace scaffold under `src/mcp-orc-rust`
- `mcpo` compatibility CLI
- Config loading and validation for core server shape checks
- Native-vs-compatibility bootstrap logging
- Docker replacement image and compose/build script wiring

## Native port roadmap

1. Keep expanding native transport coverage for stdio, SSE, and streamable HTTP.
2. Continue hardening OpenAPI synthesis and OAuth refresh behavior.
3. Keep startup, readiness, and hot reload behavior covered by Rust tests.

## Recommended Rust crates

- MCP transport/client/server: `rmcp`
  - https://github.com/modelcontextprotocol/rust-sdk
- OAuth 2.0 / OIDC helpers: `oauth2`, `openidconnect`
  - https://docs.rs/oauth2/latest/oauth2/
  - https://docs.rs/openidconnect/latest/openidconnect/
- HTTP server: `axum`, `tower-http`
- Async runtime: `tokio`
- HTTP client: `reqwest`
- Schema validation: `jsonschema`
- OpenAPI/schema generation helpers: `schemars`
