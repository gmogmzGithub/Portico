# Slack OAuth -- Technical Architecture

## Overview

Slack uses OAuth 2.0 user tokens (`xoxp-`) to access its Web API on behalf of a user. Portico treats Slack as a desktop public client:

- The Slack app client ID is public and stored inline in `mcp-configs/slack/slack.fragment`.
- No Slack OAuth client secret is shipped, resolved from Keychain, mounted into Docker, or sent during token exchange.
- Rust `mcp-orc` uses PKCE (`S256`) for authorization-code exchange.
- Redirects use HTTP loopback callbacks, not local HTTPS certificates.

Durable OAuth storage and runtime token delivery are broker-mediated in current builds: the host-side Electron process owns the encrypted OAuth record, and Slack runtimes receive only scoped access-token material through the MCP secret broker. See [`mcp-secret-broker.md`](mcp-secret-broker.md) for the shared storage/vending contract and first-time bootstrap constraints.

| Layer | Role |
|---|---|
| Electron Shell | Polls for pending authorization URLs, opens the browser for user consent |
| MCPO (Rust mcp-orc) | OAuth binding, PKCE generation, token exchange, token storage, subprocess file-ingress token delivery |
| Single-server stack | Runs the Slack MCP auth target and loopback callback listener |
| Slack MCP Server (Go) | `--transport http`; receives an OAuth access-token file path at spawn time |
| Slack API | Authorization, token exchange, Web API |

## Configuration

The Slack integration is configured via `mcp-configs/slack/slack.fragment`:

| Key | Value | Notes |
|---|---|---|
| `authorization_endpoint` | `https://slack.com/oauth/v2/authorize` | Standard Slack v2 OAuth |
| `token_endpoint` | `https://slack.com/api/oauth.v2.access` | Token exchange endpoint |
| `scope_parameter_name` | `user_scope` | Slack uses `user_scope` instead of standard `scope` |
| `credentials_source` | `{"type": "inline", "client_id": "2317524819.11152506261415"}` | Public-client PKCE. No client secret. |
| `storage_type` | `file` | Tokens persisted through the orchestrator token store |

The OAuth callback URI is chosen by the active stack:

| Stack | Callback URI |
|---|---|
| Main stack | `http://localhost:3834/callback` |
| Single-server wizard | `http://localhost:3836/callback` |

Slack app prerequisites:

- PKCE enabled for app `2317524819.11152506261415`.
- Loopback redirect URLs registered for both callback URIs above.
- User scopes only for this desktop loopback flow.

## Runtime Stack

Slack OAuth runs through the single-server stack when the user starts the guided auth flow. The callback lands on the same Rust `mcp-orc` instance that created the PKCE verifier and state value, so callback handling can verify state and exchange the authorization code.

The old HTTPS localhost callback sidecar has been removed:

- No `https://localhost:3838/callback`.
- No `oauth.crt` / `oauth.key` generation.
- No `security add-trusted-cert`.
- No macOS certificate trust prompt.

## Sequence Diagram

```mermaid
sequenceDiagram
    participant User as User (Browser)
    participant Electron as Electron App
    participant MCPO as MCPO Single-Server (Rust mcp-orc)
    participant SlackMCP as Slack MCP Server (Go)
    participant Slack as Slack API

    Note over MCPO: 1. Startup: fragment loaded with inline public client ID
    MCPO->>MCPO: OAuthConfig: client_id only; token_endpoint_auth_method = none
    MCPO->>MCPO: CompatTokenStore: check for existing tokens

    Note over MCPO: 2. Build auth URL
    MCPO->>MCPO: Generate PKCE verifier + S256 challenge
    MCPO->>MCPO: Generate state param
    MCPO->>MCPO: Store PKCE + state in AuthorizationState

    Note over MCPO: Auth URL includes client_id, HTTP loopback redirect_uri, user_scope, state, code_challenge, code_challenge_method=S256

    MCPO->>MCPO: coordinator.set_authorization_url()

    Note over Electron,MCPO: 3. User authorization
    Electron->>MCPO: GET /oauth/current
    MCPO-->>Electron: {server: "slack", url: "https://slack.com/oauth/v2/authorize?..."}
    Electron->>User: Open auth URL in browser
    User->>Slack: User reviews scopes and approves

    Note over Slack,MCPO: 4. Callback
    Slack->>MCPO: 302 to http://localhost:3836/callback?code=AUTH_CODE&state=...
    MCPO->>MCPO: OAuthBinding::handle_callback() extracts code and verifies state

    Note over MCPO,Slack: 5. Token exchange
    MCPO->>Slack: POST https://slack.com/api/oauth.v2.access with client_id, code, redirect_uri, code_verifier
    Slack-->>MCPO: {access_token: "xoxp-...", refresh_token: "..."}
    MCPO->>MCPO: CompatTokenStore persists tokens

    Note over MCPO,SlackMCP: 6. Spawn MCP server with token file
    MCPO->>MCPO: Read stored xoxp token
    MCPO->>SlackMCP: Write 0600 token file and spawn with file path env
    SlackMCP->>SlackMCP: Boot: auth test and cache warm-up
    MCPO->>SlackMCP: Connect streamable-http /mcp

    Note over MCPO,Slack: 7. Tool calls
    Electron->>MCPO: MCP read-only or confirmed tool call
    MCPO->>SlackMCP: POST /mcp
    SlackMCP->>Slack: Slack Web API call with xoxp token
    Slack-->>SlackMCP: API response
    SlackMCP-->>MCPO: MCP tool result
    MCPO-->>Electron: Tool result
```

## Key Implementation Details

### PKCE Public Client

Rust `mcp-orc` maps inline credentials with no `client_secret` to a public client:

- `token_endpoint_auth_method` is `none`.
- Authorization URLs include `code_challenge` and `code_challenge_method=S256`.
- Code exchange sends `client_id` and `code_verifier`.
- Refresh sends `client_id`.
- Neither exchange nor refresh sends `client_secret`.

### `user_scope`

Slack OAuth uses `user_scope` instead of the standard `scope` query parameter. The `scope_parameter_name` config field makes the Rust orchestrator rewrite the generated authorization URL accordingly.

### Access Token Injection

An earlier approach used an OAuth proxy patch to forward Bearer tokens per request. That was discarded because the Slack MCP server needs a static token at startup for auth checks, cache warm-up, and background watchers.

`session.rs::HttpSubprocessConfig` supports `oauth_access_token_file_env`,
where the orchestrator writes the token to a user-scoped `0600` file and
passes only the file path. Slack must use this file-ingress path. The bundled
Slack MCP binaries carry an Portico patch that reads
`SLACK_MCP_OAUTH_ACCESS_TOKEN_FILE` directly; upstream
`korotovsky/slack-mcp-server` only reads token values from environment
variables today. The legacy `oauth_access_token_env` compatibility option is
audit-blocked for Slack and must not be used in product configuration.

Current Slack flow:

1. The orchestrator reads the stored `xoxp-` token.
2. It writes the token to an ephemeral `0600` file and passes only the file path
   through `oauth_access_token_file_env`.
3. The patched Slack MCP server reads the file and performs its normal Web API
   startup checks. The patch does not export the token into
   `SLACK_MCP_XOXP_TOKEN`.

## Component Map

| File | Layer | Purpose |
|---|---|---|
| `mcp-configs/slack/slack.fragment` | Config | Server command, OAuth endpoints, scopes, inline public client ID |
| `src/mcp-orc-rust/crates/mcp-orc/src/session.rs` | Orchestrator | `oauth_access_token_file_env` token ingress into subprocess at spawn |
| `src/mcp-orc-rust/crates/mcp-orc/src/oauth/binding.rs` | Orchestrator | OAuth binding, PKCE, `scope_parameter_name` rename, token exchange and refresh |
| `src/mcp-orc-rust/crates/mcp-orc/src/oauth/coordinator.rs` | Orchestrator | OAuth state machine, handshake queue, callback routing |
| `src/mcp-orc-rust/crates/mcp-orc/src/oauth/config.rs` | Orchestrator | Credential loading and redirect URI selection |
| `src/mcp-orc-rust/crates/mcp-orc/src/oauth/storage.rs` | Orchestrator | Token persistence (`{server_hash}_tokens.json` and `{server_hash}_client.json`) |
| `src/scripts/start-single-mcp-server.sh` | Infra | Single-server stack and HTTP loopback callback |
| `electron-app/src/services/setup-auth.js` | Electron | Polls `/oauth/current`, opens browser, waits for callback |

## Legacy Cleanup

Older local development states may have Slack OAuth token files or client-info files produced by the former confidential-client flow. Startup clears Slack token and client-info files once so normal readiness detection asks the user to reconnect through PKCE. This is a migration marker only; it is not an auth-state flag.

Legacy Slack client credential keys are also scrubbed from plaintext env files and runtime env mirrors:

- `SLACK_OAUTH_CLIENT_ID`
- `SLACK_OAUTH_CLIENT_SECRET`
- `SLACK_OAUTH_CLIENT_ID_FILE`
- `SLACK_OAUTH_CLIENT_SECRET_FILE`

They are no longer read, exported, mounted, or delivered to any container.
