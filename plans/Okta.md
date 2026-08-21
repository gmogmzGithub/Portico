## First-Run Login + Setup Simplification

### Summary

- Replace the first-run welcome CTA flow with a setup-scoped Okta login gate, then continue directly to prerequisites.
- Remove the bundled `browser-use` integration and all Playwright-specific prerequisite/install logic.
- Make dark mode the first-run default everywhere, independent of system theme, while preserving manual theme toggling after that.
- OAuth approach should follow Okta’s Authorization Code + PKCE guidance, Okta Native Application guidance, RFC 8252 native-app best practices, and Electron `safeStorage` for encrypted local persistence:
  - Okta PKCE: https://developer.okta.com/docs/guides/implement-grant-type/authcodepkce/main/
  - Okta native app redirect model: https://developer.okta.com/docs/guides/sign-into-mobile-app-redirect/-/main/
  - RFC 8252: https://www.rfc-editor.org/rfc/rfc8252
  - Electron `safeStorage`: https://www.electronjs.org/docs/latest/api/safe-storage

### Implementation Changes

- Welcome / stage flow
  - Update the first screen copy to:
    - `Built with ❤️ by Porticoians, for Porticoians.`
    - remove the two existing welcome/setup-duration lines
    - change the CTA label to `Let's go!`
  - Replace the current `startSetup()` behavior with:
    - maximize window as today
    - swap the welcome view into a loading state with spinner + `First, let's get you logged in...`
    - hold that state for a fixed 3 seconds
    - then start the Okta login flow
    - on success, skip/remove the manual `welcome-user` stage and show prerequisites
    - on failure or cancel, restore the welcome CTA with an inline retryable error
  - Remove the `welcome-user` step from the guided-setup progression and progress tracker, and stop gating `server-selection` on `completedSteps.welcomeUser`.
  - Persist `PORTICO_USER_ID` and `PORTICO_USER_NAME` immediately after login instead of collecting them manually.
  - Claim mapping defaults:
    - `PORTICO_USER_ID`: `preferred_username`, else local-part of `email`
    - `PORTICO_USER_NAME`: `name`, else `given_name + family_name`, else `PORTICO_USER_ID`

- Okta auth implementation
  - Add a main-process auth service dedicated to first-run setup login rather than reusing MCP integration OAuth.
  - Discovery / config defaults:
    - issuer: `https://id.example.invalid/oauth2/default`
    - discovery URL: `https://id.example.invalid/oauth2/default/.well-known/openid-configuration`
    - client type target: Okta Native Application
    - client ID default during implementation: `0oatwbg0ephJywyTF4x7`, but the code should read this from one central config constant because the final Native-app registration may require a new client ID
    - scopes: `openid profile email offline_access`
    - redirect URI used by the app: `http://127.0.0.1:8877/callback`
    - also accept `http://localhost:8877/callback` as a registered equivalent if admin keeps both, but generate auth requests with `127.0.0.1`
  - Flow details:
    - use Authorization Code + PKCE
    - generate `state`, `code_verifier`, and `code_challenge` in the main process
    - open the Okta authorize URL in the system browser with `shell.openExternal`
    - do not use an embedded `BrowserWindow`, `<webview>`, or in-app login page
    - spin up an ephemeral loopback HTTP listener only for the active auth session
    - validate both `state` and the exact redirect URI used for the request before token exchange
    - exchange the code for tokens against the discovered token endpoint
    - use ID token claims first; call `userinfo` only if the chosen claims are missing
  - Persistence:
    - store the token bundle in `app.getPath('userData')` as encrypted bytes using Electron `safeStorage`
    - persist at least: issuer, clientId, scopes, access token, refresh token, ID token, expiry metadata, and resolved user claims
    - keep encryption in the main process only; the renderer should never see raw persisted storage primitives
    - if `safeStorage` is unavailable or Linux reports `basic_text`, fail closed with a blocking auth-storage error instead of writing plaintext tokens
  - App interfaces:
    - add preload-safe APIs for setup auth such as `start`, `status`, `clearError`, and `getCachedSessionSummary`
    - add matching IPC handlers in the main process
    - keep all PKCE, token exchange, refresh, and disk encryption logic out of renderer code
  - Session behavior:
    - this change is setup-scoped, not a full app-wide auth wall for the post-setup manager UI
    - if a valid stored setup session exists when the first-run wizard loads, skip the login prompt and continue
    - if the stored session is expired but refreshable, refresh silently in main process before falling back to interactive login

- Prerequisites / bundled integrations / theme defaults
  - Prerequisites:
    - remove Playwright installation from phase 2 entirely
    - rename/update phase-2 logging/comments so it no longer mentions Playwright
    - remove Playwright checks from host-mode detection and messaging
    - keep Node.js + `npx` checks for bundled `chrome-devtools`
    - stop treating `uv/uvx` as a built-in prerequisite for bundled host support now that `browser-use` is gone
  - Browser-use removal:
    - delete all files under `mcp-configs/browser-use`
    - remove `browser-use` from any system-server allowlists and “modifiable built-in server” exceptions in Python/Rust validation and assistant code
    - update host-mode copy, docs, and any built-in server assumptions that mention `browser-use`
    - update tests that currently assert `browser-use` exists as a bundled server
  - Dark mode default:
    - set authoritative app default theme to `dark` in shared main-process state
    - change renderer bootstraps that currently fall back to `matchMedia` so first-run defaults to `dark` when no stored preference exists
    - preserve manual toggle behavior and persistence once the user explicitly changes theme

### Public APIs / Interfaces

- Add a setup-auth IPC surface exposed through preload for the guided setup renderer.
- Remove the implicit bundled-system-server contract for `browser-use`.

### Test Plan

- Renderer / flow tests
  - start
  - successful auth skips `welcome-user` and lands on prerequisites
  - auth cancel, timeout, callback mismatch, and token-exchange failure all restore a retryable welcome state
- Auth service tests
  - PKCE params
  - callback handler rejects mismatched state or unexpected redirect URI
  - encrypted session round-trip via `safeStorage`
  - claim-resolution precedence for `PORTICO_USER_ID` / `PORTICO_USER_NAME`
  - silent refresh path and expired-session fallback
  - allowlist / validation tests no longer treat `browser-use` as a special built-in editable server
- Manual verification
  - first install on a machine with light system theme still opens in dark mode
  - login opens the system browser, returns to the app through `127.0.0.1:8877/callback`, stores encrypted tokens, and proceeds to prerequisites
  - a second first-run launch with a valid stored session skips the login prompt
  - Chrome DevTools remains available as the only bundled host integration

### Assumptions and Defaults

- The chosen target is a Native Okta app integration, not the current SPA configuration.
- The plan assumes issuer `https://id.example.invalid/oauth2/default`.
- The current client ID is treated as a temporary default in code, but the implementation must make swapping to a new Native-app client ID trivial.
- The setup login replaces the manual `welcome-user` stage entirely.
- `preferred_username` is the primary LDAP-like claim; email local-part is the fallback.
- Logout UI and a full post-setup authenticated app shell are out of scope for this change.
