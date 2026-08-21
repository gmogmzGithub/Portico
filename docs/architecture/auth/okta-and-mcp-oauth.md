# OAuth / Okta Authentication in Portico

This document covers the two distinct OAuth systems in the application:

1. **Setup Auth (Okta)** -- first-run user identity login on the welcome screen
2. **MCP Server OAuth** -- per-server OAuth for Docker-based MCP integrations (Glean, Google Workspace, Atlassian, etc.)

---

## System 1: Setup Auth (Portico Okta Login)

This is the "first-run login gate" that authenticates the user against Portico's Okta before they can proceed through the guided setup wizard. It operates across the **Electron Shell**, **IPC/Communication**, and **State & Persistence** architecture layers.

### Okta Application Configuration

| Setting | Value |
|---|---|
| Issuer | `https://id.example.invalid/oauth2/default` |
| Discovery URL | `https://id.example.invalid/oauth2/default/.well-known/openid-configuration` |
| Client ID | `0oatwbg0ephJywyTF4x7` |
| Client Type | **Native Application** (Okta "native" app type) |
| Scopes | `openid`, `profile`, `email`, `offline_access` |
| Redirect URI | `http://127.0.0.1:8877/callback` |
| Grant Types | `authorization_code` (with PKCE), `refresh_token` |

The issuer and client ID can be overridden via `SETUP_AUTH_ISSUER` and `SETUP_AUTH_CLIENT_ID` environment variables.

**Key point for Guillermo:** This uses the **default authorization server** under Portico's Okta domain (`/oauth2/default`). No custom scope or dedicated workspace was requested -- it uses the standard OpenID Connect scopes (`openid profile email offline_access`) on the default domain available to all Portico employees.

### What Was Set Up in Okta

1. A **Native Application** was registered in Okta with client ID `0oatwbg0ephJywyTF4x7`
2. The app is configured as a **public client** (no client secret) -- appropriate for desktop/native apps per RFC 8252
3. **PKCE (S256)** is required for all authorization requests
4. The redirect URI is `http://127.0.0.1:8877/callback` (loopback, per RFC 8252 Section 7.3)
5. `offline_access` scope is enabled to obtain refresh tokens for silent re-authentication

No custom scopes, custom authorization servers, or resource servers were requested. The app only needs to identify the user (name, email) -- it doesn't call any Portico APIs with the token.

### Key Files

| File | Role |
|---|---|
| `electron-app/src/config/setup-auth-config.js` | All OAuth configuration constants |
| `electron-app/src/services/setup-auth.js` | Main auth service (login, refresh, session management) |
| `electron-app/src/services/setup-auth-shared.js` | PKCE generation, URL building, claim resolution |
| `electron-app/src/services/ipc.js` | IPC handlers (`setup-auth-start`, `setup-auth-status`, etc.) |
| `electron-app/src/services/preload.js` | Renderer-side API bridge (`window.electronAPI.setupAuth`) |
| `electron-app/src/renderer/views/guided-setup.js` | UI orchestration (`startSetup()`, error handling) |
| `electron-app/src/renderer/views/guided-setup.html` | Welcome screen HTML (the "Let's go!" button) |

### PKCE Implementation

Implemented in `setup-auth-shared.js`:

- **Code Verifier**: 64 random bytes via `crypto.randomBytes(64)`, base64url-encoded
- **Code Challenge**: SHA-256 hash of the verifier, base64url-encoded
- **Method**: Always `S256`
- **State Token**: 32 random bytes, base64url-encoded (CSRF protection)

### Complete Authentication Flow

```
User clicks "Let's go!" on welcome screen
         |
         v
guided-setup.js: startSetup()
  - Shows loading spinner ("First, let's get you logged in...")
  - Calls window.electronAPI.setupAuth.start()
         |
         v
preload.js -> IPC channel "setup-auth-start"
         |
         v
ipc.js -> setupAuth.startSetupAuth()
         |
         v
setup-auth.js: startSetupAuth()  [singleton - prevents duplicate flows]
         |
    +---------+
    | Cached?  |--yes--> Return cached session (source: "cache")
    +---------+
         |no
    +---------+
    | Expired  |--yes+refresh_token--> Attempt silent refresh
    | w/refresh|                            |
    +---------+                        success -> Return (source: "refresh")
         |no                           failure -> Clear session, continue
         v
    1. Verify safeStorage encryption is available
    2. Fetch .well-known/openid-configuration from Okta
    3. Generate PKCE pair (verifier + challenge)
    4. Generate state token
    5. Build authorization URL
    6. Start local HTTP server on 127.0.0.1:8877
    7. Open system browser via shell.openExternal(authUrl)
         |
         v
  [User authenticates in their default browser via Okta]
         |
         v
  Okta redirects to http://127.0.0.1:8877/callback?code=...&state=...
         |
         v
  Local HTTP server receives callback:
    - Validates state matches
    - Extracts authorization code
    - Serves success HTML page to browser
    - Shuts down HTTP server
         |
         v
  Token exchange: POST to Okta token_endpoint
    - grant_type=authorization_code
    - client_id=0oatwbg0ephJywyTF4x7
    - redirect_uri=http://127.0.0.1:8877/callback
    - code=<authorization_code>
    - code_verifier=<pkce_verifier>
         |
         v
  Decode ID token claims -> resolve user identity
         |
         v
  Encrypt session with safeStorage -> write to setup-auth-session.bin
         |
         v
  Set PORTICO_USER_ID and PORTICO_USER_NAME in .env
         |
         v
  Navigate to "hello" stage (mode selection)
```

### Token Storage

| Aspect | Details |
|---|---|
| Location | `{app.getPath('userData')}/setup-auth-session.bin` |
| Encryption | Electron `safeStorage.encryptString()` -- uses OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service) |
| Contents | JSON with: access_token, refresh_token, id_token, token_type, issuedAt, expiresAt, user info, OAuth metadata |

### Token Refresh

When a cached session is found but expired:

1. POST to the discovered `token_endpoint` with `grant_type=refresh_token`
2. Sends `client_id`, `refresh_token`, and `scope`
3. On success: persists new session, returns immediately
4. On failure: clears stored session, falls through to interactive login

The token expiry check includes a 60-second skew buffer (refreshes 1 minute before actual expiry).

### User Identity Mapping

From the ID token claims (`setup-auth-shared.js: resolvePorticoUserClaims()`):

- **PORTICO_USER_ID**: `preferred_username` -> email local-part -> `sub` -> `'unknown-user'`
- **PORTICO_USER_NAME**: `name` -> `given_name + family_name` -> falls back to user ID

These values are written to the `.env` file and used throughout the app to identify the current user.

### Error Handling

Error codes are mapped to user-friendly messages in `guided-setup.js: formatSetupAuthError()`:

| Error Code | Meaning |
|---|---|
| `access_denied` | User denied consent or lacks access |
| `auth_timeout` | 3-minute timeout waiting for callback |
| `state_mismatch` | CSRF state validation failed |
| `token_exchange_failed` | Code-for-token exchange failed |
| `network_error` | Cannot reach Okta |
| `encryption_unavailable` | OS keychain not available |

---

## System 2: MCP Server OAuth (Per-Integration)

This is a completely separate OAuth system that handles authentication for individual MCP server integrations running inside Docker containers. It operates across the **MCP Orchestration** and **Docker Orchestration** layers.

### Architecture

```
Electron App (UI + IPC)
      |
      v
nginx container ("mcpo") -- port 8765 (API), port 3834 (OAuth callbacks)
      |
      v
openapi-aggregator -- routes OAuth callbacks by state param
      |
      v
Per-server MCPO containers -- each has its own OAuth provider + token storage
```

### MCP OAuth vs Setup Auth

> **Broker-era note:** MCP OAuth durable storage moved from host-mounted JSON token directories to Electron `safeStorage`. Containers now receive scoped broker-vended runtime material. See [`mcp-secret-broker.md`](mcp-secret-broker.md) for the current durable-record and broker contract.

| Aspect | Setup Auth (Okta) | MCP Server OAuth |
|---|---|---|
| Purpose | Identify the Portico user | Authenticate with external services |
| Provider | Portico Okta (`id.example.invalid`) | Various (Glean, Google, Atlassian, etc.) |
| Where it runs | Electron main process (Node.js) | OAuth handshake runs through Rust `mcp-orc`; durable records are owned by Electron in broker-era builds |
| Token storage | Encrypted binary via `safeStorage` | Electron `safeStorage` durable record; legacy `mcpo-oauth-tokens/` records are migration inputs only |
| Callback port | `127.0.0.1:8877` | `localhost:3834` (main) or `localhost:3836` (single) |
| PKCE | Node.js `crypto` module | Rust `mcp-orc` OAuth binding |
| Flow result | Sets `PORTICO_USER_ID`/`PORTICO_USER_NAME` | Stores a host-side OAuth record used by broker-vended MCP runtime access-token material |

App-owned loopback ports are reserved in
`electron-app/src/config/local-service-ports.js`: Okta setup auth uses `8877`,
GitLab marketplace auth uses `8878`, and the development LLM debug monitor uses
`8879`.

### Guided Setup OAuth Flow (Single-Server Mode)

During guided setup, the main Docker infrastructure is not yet running. Instead, an isolated single-server stack is used:

1. Start isolated server via `start-single-mcp-server.sh` (ports 8770/3836)
2. Poll until healthy (90s timeout)
3. Get OAuth URL from the single server
4. Open browser via `shell.openExternal(authUrl)`
5. Poll for completion (5 min timeout, 2s intervals)
6. Verify tokens exist on the filesystem

### MCP Token Storage

**Host path:** `./mcpo-oauth-tokens/{server_id}/tokens/`

Each per-server container mounts:
```
./mcpo-oauth-tokens/{server_id} -> /root/.mcpo (inside container)
```

Token files:
- `{hash}_tokens.json` -- access_token, refresh_token, token_type, expires_in, scope
- `{hash}_client.json` -- client_id, client_secret, redirect_uris, grant_types

The `{hash}` is the first 8 characters of MD5(server_name).

### MCPO Python OAuth

**Files:**
- `src/mcp-orc-rust/crates/mcp-orc/utils/oauth.py` -- OAuth flow implementation
- `src/mcp-orc-rust/crates/mcp-orc/utils/oauth_coordinator.py` -- State machine and handshake coordination
- `src/mcp-orc-rust/crates/mcp-orc/utils/oauth_callback.html` -- Browser callback page template

Supports two OAuth types:
- **DCR** (Dynamic Client Registration) -- client credentials are obtained automatically
- **Non-DCR** -- pre-registered client credentials in config

---

## Answering Guillermo's Questions

### "How did you set up Okta? Did you request a scope or a workspace?"

A **Native Application** was registered in Portico's Okta with client ID `0oatwbg0ephJywyTF4x7`. It uses the **default authorization server** (`https://id.example.invalid/oauth2/default`) -- no custom scope, no dedicated workspace, no custom authorization server was created. It sits under the default domain for all Portico.

The only scopes used are the standard OIDC ones: `openid`, `profile`, `email`, `offline_access`. No custom resource scopes were requested.

### "What exactly has been done?"

1. **Okta side**: Registered a Native Application (public client, no secret) with PKCE S256 required. Redirect URI set to `http://127.0.0.1:8877/callback`.

2. **App side**: Implemented a full OAuth 2.0 Authorization Code + PKCE flow in the Electron main process:
   - Discovers endpoints via `.well-known/openid-configuration`
   - Opens the system browser for Okta login (not a webview -- follows RFC 8252)
   - Listens on a local HTTP server for the callback
   - Exchanges the code for tokens
   - Decrypts ID token to get user identity
   - Encrypts and persists the session using the OS keychain
   - Supports silent refresh via refresh tokens

3. **Purpose**: The Okta token is only used to **identify the user** (set `PORTICO_USER_ID` and `PORTICO_USER_NAME`). It does not call any Portico APIs with the access token.

### "Do we need to request something else, or just connect to the .well-known path?"

The current setup already uses the `.well-known/openid-configuration` endpoint at `https://id.example.invalid/oauth2/default/.well-known/openid-configuration` for endpoint discovery. If additional access is needed (e.g., calling Portico APIs), a custom scope or resource server would need to be requested from the Okta team. But for user identification only, the current setup is sufficient.
