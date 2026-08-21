---
name: run-portico-beta-to-dev-qualification
description: "Execute a clean Portico beta-to-development upgrade qualification: preserve the designated backup, install an exact beta artifact, configure and authenticate every integration, prove beta chat and MCP health, switch to dev, validate one-way Slack OAuth migration and preserved non-Slack state, prove dev chat and security posture, fix dev-only defects, release a new build, and repeat from clean beta until every gate passes. Use when asked to test upgrade compatibility, onboarding, OAuth preservation, Slack migration, all-green MCP health, packaged security hardening, or a full beta-to-dev perfection loop."
---

# Run PORTICO Beta-to-Dev Qualification

Prove the real packaged upgrade path from a clean beta installation to a fully working development build. A partial setup, a healthy backend without UI proof, or a passing dev-only install is not sufficient.

## Operating boundaries

- Use normal shell tools for source edits, tests, git, release commands, filesystem work, Docker, logs, APIs, Keychain commands, and artifact inspection. Never depend on Zed.
- Use Computer Use only for application and browser interactions that lack a reliable command surface: setup wizard choices, OAuth consent, updater prompts, and final visual verification.
- Keep supplied credentials out of source, logs, command output, process arguments, snapshots, and reports. Use the user-supplied repository `.env`, inherited environment variables, or intended secure stores.
- Treat repository `.env` as protected release-operator input, not installed-app state. Never delete, truncate, rename, or overwrite it during a clean baseline, and never replace a Cloudsmith value present there with a Keychain, broker, cached, or previously exported value.
- Use targeted PORTICO-owned cleanup that excludes the checkout. `clean_dev.sh` and `clean_full.sh` now preserve repository `.env`, but full cleanup still removes other ignored output. Treat any `.env` mutation as a fail-closed bug; never move or delete it during qualification.
- Preserve the designated recovery backup byte-for-byte. Create it once only when the user requests one; never overwrite it during repeat iterations.
- Work around beta-only defects without changing beta source. Apply code fixes only to dev, add regression coverage, and preserve public interfaces unless the reproduced defect requires a change.
- Preserve unrelated Docker state, browser login sessions, repository files, and dirty worktree output.
- Use “update” for normal managed-runtime synchronization. Reserve damage-restoration language for evidence-backed corruption.

## Required inputs

Record the exact beta DMG, beta build number and full SHA, recovery backup path, managed-root path, expected integration inventory, deterministic beta/dev prompts, current dev release channel, and the mode and SHA-256 digest of the protected repository `.env`. Confirm its `CLOUDSMITH_API_KEY` assignment exists without printing the value. Do not start from an inferred or newest artifact.

Read [references/qualification-checklist.md](references/qualification-checklist.md) before deleting the baseline or beginning OAuth work.

## 1. Establish a clean beta baseline

1. Stop only PORTICO-owned processes and containers.
2. Remove PORTICO-owned volumes, app bundle, managed root, Application Support/cache state, OAuth state, and PORTICO Keychain entries while preserving the named backup, repository `.env`, and unrelated state.
3. Install the exact arm64 beta DMG into canonical `/Applications/Portico.app`.
4. Verify signature, beta channel, build number, full SHA, and architecture before launch.
5. Recreate caller-supplied compatibility files such as `~/.snowflake/connections.toml` with mode `0600` when the old beta requires them.

## 2. Configure and prove beta

1. Select the required feature mode and enable every visible integration, including host integrations such as Chrome DevTools.
2. Enter static credentials without echoing or persisting them outside intended stores.
3. Complete each OAuth flow using its provider-specific consent sequence.
4. If the beta incorrectly resolves a mutable helper-image tag, override it with the exact beta-tagged image. Do not patch beta source.
5. Require every expected server to be enabled, connected, healthy, and broadcasting tools.
6. Send the deterministic beta prompt and require the exact successful response.
7. Hold the beta state stable for at least 60 seconds and recheck logs, processes, endpoints, and container health.

## 3. Capture a secret-free pre-upgrade snapshot

Capture enabled server IDs, health state, tool counts, image tags, API inventories, and OAuth record filenames. Never capture credential contents. Store transient evidence outside the repository.

## 4. Upgrade and validate migration

1. Switch the installed app to Development and wait for the exact update to download and stage.
2. Immediately before installation, remove only state intentionally under migration test. For Slack migration, remove Slack encrypted OAuth records, Slack legacy client/token records, and Slack Keychain accounts while preserving every non-Slack record and the shared encryption key.
3. Leave any explicitly required beta plaintext migration input in place so dev startup must consume and remove it; verify removal after startup.
4. Install the staged update and verify signature, channel, build number, full SHA, and expected image tag.
5. Before reauthorizing the migrated integration, require every unaffected integration to remain healthy while only the target integration requests authentication.
6. Complete the new OAuth flow through the intended control plane, then require every integration to return green with tools available.
7. Send the deterministic dev prompt and require the exact successful response.

## 5. Prove runtime and security gates

Require all expected loopback ports and health endpoints, `/servers`, aggregated OpenAPI inventories, release-tagged healthy containers, 60-second stability, no fresh startup errors, and `SECURITY AUDIT RESULT: GREEN`. Run the repository’s canonical `./run-tests.sh` before closing the iteration.

## 6. Fix dev defects and repeat

1. Collect evidence from the installed artifact and fresh logs before editing source.
2. Implement the narrow dev fix using normal repo tools, add regression coverage, and run targeted tests plus `./run-tests.sh`.
3. Commit only intended files, push, and verify `HEAD` equals upstream.
4. Source the protected repository `.env` with shell tracing disabled, then use [the dev release loop](../run-portico-dev-release-loop/SKILL.md) and `./run_dev_release.sh` to package and publish outside Zed. Do not consult a fallback Cloudsmith credential when `.env` contains the assignment.
5. Restart from the clean beta baseline without creating another backup.
6. Continue until one entire beta-to-dev iteration passes every gate. Leave the working dev installation running and the recovery backup unchanged.
