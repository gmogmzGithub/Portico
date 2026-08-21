# Host MCP Bridge Architecture

The Host MCP Bridge is the local, authenticated MCP gateway that lets external developer clients use the Portico MCP toolbox through one stable loopback endpoint.

User-facing setup instructions live in [`../../MCPBridge.md`](../../MCPBridge.md). This document describes the maintainer contract introduced by `b8a971d3` and extended by later secret-broker work.

## Purpose

The bridge exists so external MCP clients do not need to know the app's generated Docker topology, enabled-server set, OAuth state, per-server ports, or host-vs-container deployment details.

```text
External MCP client
  └─ http://127.0.0.1:8891/mcp
       └─ Host MCP Bridge
            ├─ active PORTICO MCP stack and generated server routes
            └─ shared system, user, and marketplace skill catalog
```

The bridge is not a general public API. It is a local desktop integration point for user-approved MCP clients.

## Process and Endpoints

Electron launches `mcp-orc bridge` as the Host MCP Bridge daemon. The normal endpoint set is:

| Endpoint | Auth | Caller | Purpose |
|---|---:|---|---|
| `/health` | No | Electron | Liveness check and restart decisions |
| `/mcp` | Yes | External MCP clients | Streamable HTTP MCP server |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | No | External MCP clients | Return a parseable `404 oauth_not_supported` response; the bridge does not publish OAuth authorization-server metadata |

Later broker work also uses the same daemon for internal container endpoints:

| Endpoint | Auth | Caller | Purpose |
|---|---:|---|---|
| `/bridge/status` | Yes, scoped `bridge:status` | Scheduling daemon | App/bridge readiness gate before scheduled runs are claimed |
| `/secrets/oauth/access-token` | Yes, scoped | MCP runtime containers | Runtime OAuth access-token vending |
| `/secrets/static-secret` | Yes, scoped | MCP runtime containers | Runtime static-secret materialization |

`/bridge/status` proxies Electron's local `/api/mcp/bridge/status` readiness endpoint with the internal Electron broker token. It deliberately requires a token scoped to exactly `bridge:status` so the scheduler can check readiness without receiving broader MCP or secret-broker authority. See [`../auth/mcp-secret-broker.md`](../auth/mcp-secret-broker.md) for the broker endpoints. The rest of this document focuses on `/mcp` client access.

## Bearer-Token Authentication

The bridge requires `Authorization: Bearer <token>` for `/mcp`. Electron owns the token lifecycle:

1. Create or reuse a client token under the app `userData` directory.
2. Store the raw token in a private PORTICO-owned token file.
3. Store only a salted SHA-256 token hash in the auth registry.
4. Launch the bridge with `--auth-registry <path>`.
5. Configure the selected external clients with the URL and a token-reading strategy.

The Rust bridge reads and validates the complete registry on each auth check, ignores revoked entries, hashes the presented bearer token with the stored salt, and compares the expected hash in constant time. Authentication succeeds only when exactly one active record matches. `/health` intentionally remains unauthenticated so Electron can recover the daemon.

Bridge tokens have no TTL and there is no HTTP refresh or token-vending endpoint for external clients. Once a token is active, Electron never replaces its raw bytes implicitly: an unavailable token file or hash mismatch fails without changing the registry, and a scope change updates the same token's registry record. Only explicit removal permits a later setup to mint a replacement; removal persists the revoked registry record before deleting the token file. If a fresh mint's registry commit fails, Electron restores prior token-file bytes when possible and emits a fixed rollback-failure reason otherwise. Mint, scope-update, failure, and revocation logs contain only fixed reason codes, client ID, and whether state changed.

### Registry Shape

The registry is JSON with versioned token records:

```json
{
  "version": 1,
  "updatedAt": "2026-06-05T13:45:52.000Z",
  "tokens": [
    {
      "clientId": "amp",
      "displayName": "Amp",
      "tokenHash": "sha256:<salt>:<digest>",
      "tokenFile": "/.../host-mcp-bridge/tokens/amp.token",
      "createdAt": "...",
      "updatedAt": "...",
      "revoked": false
    }
  ]
}
```

Later broker changes add a `scopes` field to the same records. External client tokens normally have no scopes. `/bridge/status` and `/secrets/...` require matching scopes in addition to an active token; `/mcp` currently applies the active-token check regardless of scope. Version 1 records are fail-closed: client IDs must be canonical and case-insensitively unique, hashes must use the exact lowercase `sha256:<32-hex-salt>:<64-hex-digest>` form, `revoked` must be explicit, and any scopes must be sorted, unique, trimmed, nonempty printable-ASCII strings.

## Client Auto-Configuration

The app-managed configuration flow supports:

| Client | Configuration strategy |
|---|---|
| Claude Code | Streamable HTTP config with a `headersHelper`; each helper invocation reads the current token file |
| Claude Desktop | Local stdio proxy command owned by PORTICO; the proxy reads the current token before each forwarded HTTP request |
| Codex | Direct streamable HTTP config in `config.toml`; the token stays static until explicit client removal and reconfiguration |
| Cursor | Direct streamable HTTP config in `mcp.json`; the token stays static until explicit client removal and reconfiguration |
| Amp | Direct streamable HTTP config in Amp settings JSON/JSONC; the token stays static until explicit client removal and reconfiguration |

Config writers should use atomic writes and backups. They must not print bearer tokens into chat, renderer logs, or user-facing snippets. The deprecated `mcp-bridge-setup` skill intentionally redirects users to this UI instead of producing manual token snippets.

A direct HTTP client that receives its first `401` with `WWW-Authenticate: Bearer error="invalid_token"` should reread the private token file, rebuild its HTTP/MCP transport, and retry once. Helper- and proxy-based clients get the current file contents on their next helper invocation or proxy request. If the retry still fails, explicitly remove and reconfigure that client in the app. Do not use OAuth discovery or a refresh endpoint for bridge-token recovery: the well-known routes return an explicit `404 oauth_not_supported`, and the bridge exposes no authorization, token, registration, or refresh endpoint.

For the setup-community POC, the same writers are exposed through one local Electron REST hook:

| Endpoint | Purpose |
|---|---|
| `GET http://127.0.0.1:9876/api/mcp/bridge/status` | Report operational bridge readiness booleans for app-managed readiness checks |
| `GET http://127.0.0.1:9876/api/mcp/bridge/clients` | Report whether the bridge is healthy, which supported clients are detected/configured, and whether scripts should enable PORTICO or fall back to ToolHive |
| `POST http://127.0.0.1:9876/api/mcp/bridge/enable` | Ensure the bridge is healthy, then idempotently configure detected or explicitly requested clients |
| `POST http://127.0.0.1:9876/api/mcp/bridge/disable` | Stop the Host MCP Bridge runtime and free its port without removing client configuration |

`clients` is read-only and does not start or configure the bridge. Its `scriptAction` is `ready` when a client is already configured and the bridge is healthy, `enable_bridge` when PORTICO is reachable and a supported client can be activated, and `fallback_toolhive` when the PORTICO path is not actionable. `status` is reserved for operational readiness and returns only readiness booleans such as `bridgeReady`, `bridgeEnabled`, and `brokerAuthReady`. `enable` and `disable` are mutating local automation routes and require `X-PORTICO-Programmatic-Bridge: 1`. `enable` accepts `client_ids` / `clientIds` for explicit selection. If omitted, it selects detected or already-configured supported clients. `disable` only stops the runtime and returns `fallback_toolhive`; client config removal remains an explicit UI action in the Host MCP Bridge client configuration modal. Scripts should treat a failed connection, failed `enable`, or non-2xx response as "PORTICO is unavailable for this POC" and continue down the existing ToolHive path. To undo or switch paths during the POC, users should rerun `setup-community/run-mcp-servers`; that keeps ToolHive fallback behavior controlled by the setup scripts rather than manual config edits. The response must stay redacted; raw bearer tokens remain in PORTICO-owned token files only.

## Tool Surface

By default the bridge exposes a small discovery surface:

| Tool | Purpose |
|---|---|
| `find_relevant_tools` | Search the active PORTICO MCP toolbox and return bridge tool names |
| `call_bridge_tool` | Invoke a returned bridge tool with JSON arguments |
| `find_relevant_skills` | Rank installed skill metadata against the user's goal |
| `load_skills` | Load selected `SKILL.md` instructions and lazy resource manifests |
| `load_skill_resource` | Read one exact safe supporting file without executing it |

This keeps external clients from ingesting every PORTICO tool definition or skill body up front. It also lets the bridge centralize naming, ranking, downstream routing, and skill-resource safety.

The MCP initialize response gives clients the canonical discovery sequence: search skills, load only selected skills, retrieve supporting files lazily, and use the two generic MCP tools for actions. The same instructions are emitted by the direct HTTP server and the Claude Desktop stdio proxy. Essential next-step guidance is repeated in tool descriptions for clients that make weaker use of server instructions.

### Skill Catalog and Resource Contract

- The bridge calls the shared Rust skill catalog directly; it does not proxy through the Skills MCP server.
- Canonical IDs remain source-aware: system and user skills use their directory ID, while marketplace skills use `vendor/skill`. The declared frontmatter name is returned separately.
- Discovery re-scans the catalog on every call. The five-tool MCP surface is fixed, so installing a skill requires neither `tools/list_changed` nor a client restart.
- Search examines canonical and declared names, display names, triggers, and descriptions. Matching and tie-breaking are deterministic, with names weighted above triggers and descriptions and priority used before canonical ID for ties.
- `load_skills` returns the exact `SKILL.md`, selected metadata, required MCP servers, and a sorted manifest. It never eagerly embeds supporting resources.
- The resource resolver is shared with the existing Skills MCP reference reader. It accepts only exact relative regular files inside the canonical skill root and rejects absolute paths, traversal, hidden components, directories, `SKILL.md`, and canonicalized symlink escapes.
- UTF-8 resources return text. Images and audio use MCP media content blocks; other binary files use embedded `portico-skill://resource/...` blob content. Loading a script returns source bytes and never executes it.
- Limits are fail-closed and never truncate: 128 KiB per `SKILL.md`, 256 KiB across one `load_skills` call, 200 manifest entries per skill, 256 KiB per text resource, and 5 MiB per binary resource.
- Fixed-shape responses include both MCP `structuredContent` and a text fallback. Read-only skill tools use read-only, non-destructive, closed-world annotations; the generic call wrapper is conservatively annotated as potentially mutating, destructive, and open-world.

Skill-call logs contain only the operation name, canonical skill ID, result count, byte size, and error category. They must never include skill contents, bearer tokens, or absolute filesystem paths.

## Telemetry and IQL Index

Host Bridge telemetry uses a dedicated LogRepo event type. Do not use `llmProxy` spend or `porticoAiChatMcpUsage` as a proxy for Host Bridge adoption: those datasets describe PORTICO model traffic and MCP tools invoked inside PORTICO chat, respectively. Calls made by an external client through `http://127.0.0.1:8891/mcp` flow through the dedicated bridge event below.

| Layer | Name |
|---|---|
| LogRepo event type | `porticoAiChatBridgeEvent` |
| Proposed Swift/IQL index | `porticoAiChatBridgeUsageLog` |

Electron emits adoption and control-plane events best-effort through CLIP. The Rust Host Bridge emits one `bridge_tool_call` event after every authenticated external `tools/call`. LogRepo failures must never block app startup, bridge startup, status checks, client configuration, removal, or tool results. Events intentionally omit bearer tokens, token paths, config paths, helper paths, registry paths, raw URLs, raw tool arguments/results, and raw error text. Tool-call failures use a fixed `error_category`; Electron control-plane failures may also include a one-way `error_message_hash`.

Core fields for the Swift builder:

| Field | Meaning |
|---|---|
| `schema_version` | Event schema version, currently `1` |
| `event_name` | Action such as `app_launched`, `app_active_daily`, `bridge_tool_call`, `bridge_status_checked`, `bridge_enable_completed`, `client_configure_failed`, or `bridge_health_probe` |
| `event_scope` | `app` for active-user denominator rows, `tool_call` for external calls, `summary` for operation-level rows, or `client` for per-client result rows |
| `runtime_path` | `portico_app` for denominator rows or `portico_bridge` for Host Bridge tool calls |
| `outcome` | `requested`, `success`, `partial`, `failed`, `timeout`, `starting`, or `unhealthy` |
| `request_source` | `api_status`, `api_enable`, `portico_ui`, or `lifecycle` |
| `caller` | Script/UI source, for example `setup_community`, `run_mcp_servers`, `portico_ui`, or `portico_lifecycle` |
| `app_version`, `build_channel`, `platform`, `arch` | App/runtime dimensions for rollout analysis |
| `ldap`, `machine_hash` | User and privacy-preserving machine dimensions |
| `bridge_ready`, `bridge_port`, `script_action` | Bridge health and setup-script decision state |
| `supported_client_count`, `detected_client_count`, `configured_client_count`, `config_unreadable_client_count` | Inventory counts |
| `detected_client_ids`, `configured_client_ids`, `selected_client_ids`, `succeeded_client_ids`, `failed_client_ids` | Comma-delimited supported client ids |
| `client`, `client_id` | Authenticated external-client registry ID on tool-call rows; both names are emitted during index-contract migration |
| `mcp_server`, `server_id` | Downstream MCP server used by the tool call; both names are emitted during index-contract migration |
| `mcp_tool`, `tool` | Invoked bridge tool; both names are emitted during index-contract migration |
| `surface` | `meta` for the default discovery/call surface or `expose_all` for a directly exposed tool |
| `tool_call_id` | Random opaque per-call ID for de-duplication and support correlation |
| `latency_ms`, `elapsed_ms` | End-to-end bridge dispatch latency; both names are emitted during index-contract migration |
| `bridge_enabled`, `identity_source`, `is_packaged` | Active-user cohort dimensions from app adoption events |
| `timeout_ms`, `exit_code`, `pid_present`, `already_running`, `stop_reason` | Additional lifecycle and reliability dimensions |
| `error_category`, `error_message_hash` | Sanitized failure grouping |
| `ts` | Event timestamp |

The first dashboard should answer at least:

- Adoption: PORTICO daily active users from `app_active_daily`, users with any `bridge_tool_call`, active users with no bridge calls in the same window, bridge-enabled preference, bridge status checks by `script_action`, enable attempts by caller, and configured clients by `client_id`.
- Runtime usage: calls by authenticated client, LDAP, MCP server, MCP tool, and surface.
- Reliability: tool-call and enable success/failure rate, tool-call and health-probe p50/p95, failures by `error_category`, app version, platform, client, server, and tool.
- Migration: `ready` versus `enable_bridge` versus `fallback_toolhive`, users with detected-but-unconfigured clients, ToolHive fallback pressure by day.
- Support: repeated failures by user/app version, config unreadable counts, stop/start churn, and client remove activity.

### IQL query pack

These examples use the proposed `porticoAiChatBridgeUsageLog` index and current IQL aggregate syntax:

```text
# PORTICO users active in the window (the adoption denominator)
FROM porticoAiChatBridgeUsageLog 30d today
WHERE event_name = "app_active_daily"
GROUP BY ldap
SELECT count()

# Users who actually invoked the Host Bridge
FROM porticoAiChatBridgeUsageLog 30d today
WHERE event_name = "bridge_tool_call"
GROUP BY ldap
SELECT count()

# Success/failure and fixed failure categories
FROM porticoAiChatBridgeUsageLog 30d today
WHERE event_name = "bridge_tool_call"
GROUP BY outcome, error_category
SELECT count()

# MCP servers and tools used
FROM porticoAiChatBridgeUsageLog 30d today
WHERE event_name = "bridge_tool_call"
GROUP BY mcp_server, mcp_tool
SELECT count()

# p95 end-to-end dispatch latency by server and tool
FROM porticoAiChatBridgeUsageLog 30d today
WHERE event_name = "bridge_tool_call"
GROUP BY mcp_server, mcp_tool
SELECT PERCENTILE(latency_ms, 95)
```

Current IQL references do not establish a reliable single-query anti-join for “active but not using.” Export or otherwise subtract the LDAP set returned by the second query from the first. Both sides deliberately come from the same event type, identity resolution, and time window, so the comparison does not depend on correlating `llmProxy.appUserId` to bridge LDAP.

### Ingestion dependency

The desktop code defaults to sandbox CLIP and permits an operator-provided `portico_MCP_BRIDGE_LOGREPO_URL`. Creating the Swift builder/IQL index and promoting desktop events to production are separate deployment work: external production CLIP requires an approved event-type prefix and secret. Until that ingestion is provisioned and the proposed index is registered, the new fields are emit-ready but no production iDash query can read them.

## Failure Modes

| Symptom | Likely cause | Recovery |
|---|---|---|
| `401 Unauthorized` with `error="invalid_token"` from `/mcp` | Presented token has no active registry match | Reread the private token file, rebuild the transport, and retry once; then explicitly remove and reconfigure the client if it persists |
| `401 Unauthorized` with a plain `Bearer` challenge | Missing/malformed authorization, unavailable/malformed registry, unsupported version, or ambiguous match | Check the bounded rejection reason; for malformed/unsupported registry, back it up and move it aside before restarting and reconfiguring clients |
| `404` with `error="oauth_not_supported"` from a well-known route | The client attempted URL-only or OAuth registration, which the Bridge does not support | Configure the client through the PORTICO Host MCP Bridge configuration UI |
| Client config exists but bridge unreachable | PORTICO services stopped or bridge daemon down | Restart services from the debug drawer |
| Bridge works but a tool asks for OAuth/setup | Downstream integration is not authorized/configured | Complete the integration setup inside PORTICO |
| Claude Desktop works differently than others | It uses the stdio proxy path, not direct HTTP | Inspect the generated proxy command and token file path |

## Security Boundaries

- Loopback binding is required. The bridge must not be exposed on LAN/VPN interfaces.
- Raw client bearer tokens are app-owned secrets. Treat token files as sensitive.
- Inbound auth rejection logs are exponentially sampled per fixed reason, method bucket, and endpoint (occurrences 1, 2, 4, 8, ...). They never include the header, token, hash, registry contents, or filesystem paths.
- The auth registry is sensitive because hashes can still be used for offline guessing if raw token entropy is ever weakened.
- External clients receive permission to use the local bridge, not permission to bypass per-tool confirmations, OAuth, or integration-level setup.
- Installed skill text is user-selected content, not a higher-priority instruction source. Clients must ignore skill instructions that conflict with system, developer, or user instructions.
- `load_skill_resource` is read-only and never installs dependencies or executes scripts. Execution remains subject to the calling client's approval and sandbox policy.

## Related Documents

- User-facing setup: [`../../MCPBridge.md`](../../MCPBridge.md)
- Secret broker extension: [`../auth/mcp-secret-broker.md`](../auth/mcp-secret-broker.md)
- MCP system overview: [`mcp-system.md`](mcp-system.md)
