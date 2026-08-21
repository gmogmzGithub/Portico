# PORTICO beta-to-dev qualification checklist

Use this reference for the detailed evidence contract. Substitute exact run values; never paste credential values into commands, logs, or snapshots.

## Run identity

Record these values before resetting state:

```bash
BETA_DMG="/absolute/path/to/exact-arm64-beta.dmg"
BETA_BUILD="MMDDYYYY-abcdefgh"
BETA_SHA="full-40-character-beta-sha"
DEV_BUILD="MMDDYYYY-abcdefgh"
DEV_SHA="full-40-character-dev-sha"
BACKUP_PATH="/absolute/path/to/preserved-recovery-backup.zip"
APP_PATH="/Applications/Portico.app"
MANAGED_ROOT="$HOME/portico/portico-managed"
```

Hash the backup before the first reset and after final qualification. Require identical digests.

## Tool boundary

- Shell: cleanup, file modes, Docker, Keychain commands, source changes, tests, git, packaging, publishing, mounting and copying artifacts, signatures, logs, APIs, and security audit.
- Computer Use: Portico setup/update controls, browser OAuth consent, and final UI proof.
- Never use Zed as a command runner.

## Repository credential boundary

Repository `.env` is protected release-operator input and is outside the installed-app reset boundary. It is not the managed runtime's scrub-required `cloudsmith.env`.

Before the first cleanup, check only metadata and the required key name:

```bash
REPO_ENV="$PWD/.env"
test -f "$REPO_ENV"
REPO_ENV_MODE="$(stat -c '%a' "$REPO_ENV" 2>/dev/null || stat -f '%Lp' "$REPO_ENV")"
test "$REPO_ENV_MODE" = "600"
grep -Eq '^[[:space:]]*(export[[:space:]]+)?CLOUDSMITH_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$REPO_ENV"
REPO_ENV_SHA="$(shasum -a 256 "$REPO_ENV" | awk '{print $1}')"
REPO_ENV_BYTES="$(wc -c <"$REPO_ENV" | tr -d ' ')"
```

Never print or persist the value elsewhere. Prefer targeted cleanup outside the checkout. Cleanup scripts must preserve repository `.env`; treat any mutation as a fail-closed bug and never move or delete it. Require both `cmp -s` and the SHA-256 digest to remain unchanged before the next command. Never substitute a Keychain, broker, cached, or previously exported Cloudsmith value for the assignment in this file.

Immediately before release commands, source the protected file with tracing disabled:

```bash
set +x
set -a
source "$REPO_ENV"
set +a
./run_dev_release.sh all
```

After every cleanup and at final close-out, require the file still exists with mode `0600`, the same byte count, and the same digest.

## Beta reset invariants

Delete only state owned by Portico. Preserve:

- the designated recovery backup;
- the repository and unrelated worktree changes;
- the repository `.env` byte-for-byte;
- browser sessions and profiles;
- unrelated Docker containers, images, networks, and volumes;
- unrelated Keychain entries and application data.

After installation, verify the mounted and installed beta application:

```bash
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
plutil -extract buildNumber raw "$APP_PATH/Contents/Resources/build-info.json"
plutil -extract fullSha raw "$APP_PATH/Contents/Resources/build-info.json"
```

Require the exact beta build and SHA. Confirm the release channel from persisted installed state rather than UI text alone.

## Setup and OAuth sequence

Enable all 23 expected integrations in the current catalog, including Chrome DevTools. If the catalog changes, record the new expected inventory rather than silently accepting a different count.

Provider-specific consent steps:

- Glean: scroll to the end and choose **Authorize**.
- Google Workspace: choose **Allow** on the Google consent screen.
- Atlassian: choose **Approve**, select the intended production site, scroll to the end, then choose **Accept**.
- Data Platform: enter the corporate email, wait for Okta SSO to complete, then choose **Allow**.
- Datadog: choose **Authorize as** the expected corporate identity.
- Product Pal and Trust Kit: choose **Allow**.

Do not treat an OAuth callback page as proof of readiness. Return to the app and require the server to become healthy with tools.

For a beta helper-image bug caused by a mutable `latest` tag, remove only the incorrect mutable image and select the exact beta-tagged helper image. Record the workaround; do not modify beta source.

## Secret-free beta snapshot

Store transient evidence under a unique directory in `/tmp`. Capture only:

- server ID, enabled state, readiness, and tool count;
- container name, status, image, and health;
- `/servers` response structure and server count;
- aggregated OpenAPI path counts;
- encrypted OAuth record filenames, never file contents;
- build number, full SHA, release channel, and timestamp.

## Slack migration isolation

Immediately before installing dev:

1. Remove only Slack encrypted OAuth record files.
2. Remove only legacy Slack client/token files and Slack-specific Keychain accounts.
3. Preserve the shared OAuth encryption key and every non-Slack OAuth record.
4. Leave the explicit beta plaintext Slack migration input only when the test requires dev to consume it.
5. After dev startup, verify that plaintext input is gone.
6. Before Slack OAuth, require all non-Slack integrations healthy and Slack alone in the expected authentication state.
7. Authorize Slack through the shared-app control-plane flow and require its tools to appear.

## Runtime acceptance gates

Check the five loopback services:

```bash
curl -fsS --max-time 10 http://127.0.0.1:3789/
curl -fsS --max-time 10 http://127.0.0.1:4583/health
curl -fsS --max-time 10 http://127.0.0.1:8765/openapi.json
curl -fsS --max-time 10 http://127.0.0.1:8766/servers
curl -fsS --max-time 10 http://127.0.0.1:3835/health
```

Expected roles:

- `3789`: Open WebUI
- `4583`: LLM gateway
- `8765`: external MCP/control plane
- `8766`: core MCP plane and `/servers`
- `3835`: chat-state API

Require:

- all expected integrations enabled and healthy;
- each applicable server broadcasting one or more tools;
- `/servers` matching the enabled core inventory;
- aggregated OpenAPI path counts consistent with the per-server tool inventory;
- every app-owned container using the exact release tag;
- no app-owned container unhealthy or restarting;
- beta and dev each stable for at least 60 seconds with no fresh startup errors;
- deterministic beta and dev prompts returning their exact expected responses.

## Security and test gates

Run the audit from the exact installed or matching pushed source state with a PATH that includes the Docker CLI. The managed-root `cloudsmith.env` must be absent after verified secure persistence; repository `.env` remains protected operator input and is not an excuse for managed plaintext:

```bash
env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  ./security-audit.sh
```

Require exit code zero and the exact summary `SECURITY AUDIT RESULT: GREEN`. Validate that no plaintext credentials, legacy OAuth roots, unsafe bindings, public package-manager fallback, or secret-delivery regression remains.

Run the repository close-out gate:

```bash
./run-tests.sh
```

Do not close the loop on targeted tests alone. If a dev fix is required, release it with `./run_dev_release.sh all`, restart from clean beta, and rerun this entire checklist.
