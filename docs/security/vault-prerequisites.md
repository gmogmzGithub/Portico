# Vault Integration Prerequisites

**Status:** planning only.
**Audience:** engineers planning the future Vault rollout.

No Vault endpoint, token issuer, or client configuration exists in the
codebase yet. This document captures what still needs to land so that a
later change can cut over from the current Keychain-first / Docker-secret
model to Vault-backed provisioning.

The goal is a clean handoff: today's hardening leaves no caller relying on raw
environment variables or project-local plaintext files for the runtime secrets
listed below, which is the minimum precondition for a single-source-of-truth
Vault client.

---

## 1. Today's runtime secret surface (post-hardening)

| Key | Host resolution (today) | Container delivery (today) | Vault handoff target |
|---|---|---|---|
| `PORTICO_LLM_API_KEY` | env -> macOS Keychain -> managed-root/resources plaintext (install-time only) -> legacy XOR bootstrap | Docker secret `/run/secrets/portico_llm_api_key` via `PORTICO_LLM_API_KEY_FILE` | Vault client (daemon or short-lived CLI) writes Keychain + materializes session file |
| `BIFROST_BRIDGE_LOCAL_API_KEY` | env -> Keychain -> managed-root plaintext -> generated | Docker secret `/run/secrets/bifrost_bridge_local_api_key` via `BIFROST_BRIDGE_LOCAL_API_KEY_FILE` | Vault becomes the authoritative source; generation fallback retained for air-gapped installs only |
| `LOCAL_STACK_API_KEY` (+ `OPENAI_API_KEY` / `INTERNAL_OPENAI_API_KEY` / `BIFROST_BRIDGE_LOCAL_API_KEY` aliases) | env -> Keychain -> managed-root plaintext -> generated | Host-only; aliases fanned into OWUI and health-check env | Keep host-generated unless Vault also becomes authoritative for local stack identity |
| MCP `required_env_vars[].sensitive: true` values (for example `GITLAB_PERSONAL_ACCESS_TOKEN`, `SOURCEGRAPH_TOKEN`) | Dynamic YAML scan -> env migration ingress -> macOS Keychain account `<ENV_VAR>`; no plaintext fallback after migration | Docker secret `/run/secrets/<lowercase_sanitized_env_var>` mounted only into the owning MCP runtime/group and exposed as `<ENV_VAR>_FILE` until child-process spawn | Vault becomes the provider behind the same dynamic registry; YAML sensitivity remains the single source of truth |
| `CLOUDSMITH_ENTITLEMENT_TOKEN` | env -> Keychain -> managed-root/resources `cloudsmith.env` | Host only | Vault provides read token per install |
| `CLOUDSMITH_API_KEY` | Release environment or packaged updater resource | Never delivered to orchestrated containers or runtime child processes | Remains release-provisioned; Vault is out of scope |

The legacy XOR fallback (`V-007`) is still present solely to recover
`PORTICO_LLM_API_KEY` on first launch when neither Keychain nor the installer
has populated the value. It is the last remaining plaintext-derived fallback
once Vault is in place.

---

## 2. Prerequisites for Vault integration

The following pieces of infrastructure and code must exist before we can wire a
Vault provider without regressing UX or breaking packaged builds.

### 2.1 Infrastructure

- **Vault endpoint reachable from end-user machines.** Must be reachable both
  on corp network and via the standard Portico VPN/zero-trust path the DMG /
  beta channel already uses for Okta.
- **Authentication model.** Decision needed: do we reuse the Okta/SSO session
  (OIDC -> Vault) that PORTICO already obtains for Portico API access, or do we
  provision a per-install service principal? The current hardening assumes no
  new user-visible authentication step.
- **Policy / path layout** in Vault, e.g.
  `secret/portico/<install-id>/portico_llm_api_key`, with least-privilege
  read policies bound to the auth method above.
- **Rotation / revocation plan.** Keychain + Docker secret delivery assumes
  long-lived values. If Vault issues short-lived credentials we need a renewal
  loop (see 2.3).

### 2.2 Client library / CLI decision

- Choose between a Node client inside the Electron main process and shelling
  out to the `vault` CLI. The Electron main process already owns Keychain
  writes and Docker secret ingress, so it is the natural host.
- Whichever we pick must be available in packaged DMG builds without shipping
  a Vault binary (or must ship one with an acceptable size/licensing review).

### 2.3 Application-side integration points

All of these are code paths that today short-circuit to Keychain or plaintext.
Each needs a stub interface so the Vault provider can be dropped in without
touching callers.

- `electron-app/src/config/runtime-secrets-config.js`
  - Add a `SecretProvider` interface with `read(key)` / `write(key, value)` /
    `renew(key)` semantics. Today's implementation is effectively "Keychain
    then plaintext candidates"; Vault becomes a provider that sits in front of
    Keychain and falls back to it when offline.
  - The current `resolvePorticoLlmApiKey`, `resolveBifrostLocalApiKey`,
    `resolveCloudsmithEntitlementToken` functions already encode the priority
    order; they should delegate to the provider rather than reading env/files
    directly.
- `electron-app/src/services/llm-keychain.js` must remain usable as the
  offline fallback so packaged builds continue to work when Vault is
  unreachable.
- `src/scripts/docker-compose.sh :: prepare_optional_file_secret_ingress`
  already writes per-session secret files from `PORTICO_LLM_API_KEY`,
  `BIFROST_BRIDGE_LOCAL_API_KEY`, `OPENAI_API_KEY`, and any discovered
  `required_env_vars[].sensitive: true` MCP key. Once Vault is live, the
  Electron main process must populate those env vars **before** invoking the
  script; no change to the Docker secret contract is required.
- Renewal: a daemon in the main process that refreshes the Keychain entry and
  re-materializes the session file if a short-lived Vault lease is close to
  expiry. The Docker secret mount is static for the life of the compose
  project, so renewal must also trigger a compose restart for the affected
  services (today: Bifrost, mcpo-core, mcpo).

### 2.4 Observability

- Emit structured audit events from the main process whenever a secret is read
  from Vault vs. Keychain vs. the legacy bootstrap path. This lets support
  answer "why did this install fail to talk to the upstream gateway?" without
  reading plaintext from disk.
- Health-check surface must report Vault reachability without exposing the
  secret values themselves.

### 2.5 Open questions to resolve before implementation

1. Is Vault available to end-user DMG / beta installs, or only to corp
   developer machines? The answer decides whether Vault is "primary with
   Keychain fallback" or "developer-only with Keychain remaining primary".
2. How do we identify an install to Vault? `install-id` UUID already produced
   at first-run setup vs. Okta-bound identity vs. both.
3. Does the upstream LLM provider want its own rotation cadence, and if so
   does the current compose-restart cost (Bifrost cold start ~ seconds) fit?
4. What is the break-glass procedure when Vault is unreachable at launch? The
   current hardening keeps the DMG functional via Keychain; Vault adoption
   must not regress that.

---

## 3. What this hardening pass deliberately did NOT do

- No Vault client, stub, or configuration is present. The plan above is the
  authoritative reference; treat anything suggesting Vault wiring in code as
  out-of-date.
- The legacy XOR-derived `PORTICO_LLM_API_KEY` bootstrap (threat `V-007`) was
  **intentionally retained** because removing it before Vault is available
  would break first-launch for users who have not yet received a provisioned
  value.
- No user-visible authentication or configuration step was introduced. The
  only interactive authentication in packaged builds remains Portico Okta/SSO,
  exactly as before this hardening pass.

---

## 4. Cutover sketch (for the follow-up change)

Once the prerequisites in section 2 are satisfied, the cutover should look
approximately like:

1. Land the `SecretProvider` interface and move all existing callers behind
   it, without changing behavior (Vault provider still absent).
2. Introduce a Vault-backed provider behind a feature flag
   (e.g. `PORTICO_SECRET_PROVIDER=vault`). Keychain remains the fallback.
3. Validate that Docker secret ingress still works end-to-end: the Electron
   main process reads from Vault, writes the value into `PORTICO_LLM_API_KEY`
   (and friends) in its own environment, then invokes
   `src/scripts/docker-compose.sh` exactly as today.
4. After a full beta cycle, remove the legacy XOR fallback and close
   threat `V-007`. At that point the only remaining fallback is Keychain for
   offline operation.

Keeping the handoff this narrow is the reason the current hardening pass
centralized strip lists and moved container delivery to Docker secrets. The
packaged updater retains `CLOUDSMITH_API_KEY` only for its existing Cloudsmith
package-discovery contract; child processes and containers still exclude it.
