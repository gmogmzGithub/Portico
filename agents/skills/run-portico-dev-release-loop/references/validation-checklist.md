# PORTICO dev release validation checklist

Use this reference after packaging begins. Replace placeholders with values from the exact release; never paste credentials into these commands.

## Release identity

Set and preserve these values for the run:

```bash
EXPECTED_BUILD="MMDDYYYY-abcdefgh"
EXPECTED_SHA="full-40-character-git-sha"
ZIP_PATH="/absolute/path/to/portico_dev-${EXPECTED_BUILD}.zip"
APP_PATH="/Applications/Portico.app"
MANAGED_ROOT="$HOME/portico/portico-managed"
LOG_DIR="$HOME/Library/Application Support/portico/logs"
```

Before packaging:

```bash
git status --short
git diff --check
./run-tests.sh
git rev-parse HEAD
git rev-parse '@{upstream}'
```

Require the two SHAs to match. Confirm `.report-build/` and report-site output are not staged.

When repository `.env` is the user-provided release credential handoff, require mode `0600`, confirm the `CLOUDSMITH_API_KEY` key name without printing its value, and record its SHA-256 digest. Cleanup scripts must preserve this file; treat any mutation as a fail-closed bug and never move or delete it. Source this exact file with shell tracing disabled before `./run_dev_release.sh`, and do not substitute any Keychain, broker, cached, or previously exported Cloudsmith value. After cleanup and final validation, require the file digest to remain unchanged.

## Artifact checks

Require the release ZIP to exist and record its digest:

```bash
stat -f '%z %N' "$ZIP_PATH"
shasum -a 256 "$ZIP_PATH"
```

After mounting the arm64 DMG, validate both the mounted application and the installed application:

```bash
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
plutil -extract buildNumber raw "$APP_PATH/Contents/Resources/build-info.json"
plutil -extract fullSha raw "$APP_PATH/Contents/Resources/build-info.json"
```

Require the extracted build number and SHA to equal `EXPECTED_BUILD` and `EXPECTED_SHA` exactly.

## Fresh log baselines

Use the current date's files. Record byte sizes before launch rather than deleting historical logs:

```bash
APP_LOG="$LOG_DIR/app-YYYY-MM-DD.log"
ERROR_LOG="$LOG_DIR/error-YYYY-MM-DD.log"
INIT_LOG="$LOG_DIR/init-YYYY-MM-DD.log"
PREREQ_LOG="$LOG_DIR/prereq-YYYY-MM-DD.log"

APP_BASE=$(stat -f %z "$APP_LOG")
ERROR_BASE=$(stat -f %z "$ERROR_LOG")
INIT_BASE=$(stat -f %z "$INIT_LOG")
PREREQ_BASE=$(stat -f %z "$PREREQ_LOG")
```

Read fresh content with `tail -c +$((BASE + 1))`. Do not judge the final launch from whole-day logs.

Required fresh-segment invariants:

- new error-log bytes: `0`
- `Starting initialization process...`: exactly `1`
- `Managed runtime updated using`: exactly `1` when a build mismatch existed, otherwise `0`
- `Startup core sync completed`: exactly `1`
- `Initialization complete`: exactly `1`
- `[Prerequisites] Read build-info.json from bundled resources`: exactly `1`
- ordinary update paths contain no damage-restoration wording
- no `configuredServers is not defined`, uncaught exception, unhandled rejection, or `ReferenceError`

When scanning for HTTP 401s, strip the leading ISO timestamp first. A timestamp ending in `.401Z` is not an HTTP response. Treat an OAuth challenge as integration state unless it remains unresolved and blocks core startup.

## Managed image identity

List app-owned images:

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
```

Every running image under `harbor.example.invalid/portico/` must end in `:${EXPECTED_BUILD}`. Ignore intentionally external images such as Redis, MongoDB, or user-installed MCP images when evaluating this invariant.

## Runtime secret mounts

Require these files to exist and be nonempty inside their consumers:

```bash
docker exec llm-gateway sh -c \
  'test -s /run/secrets/portico_llm_api_key && test -s /run/secrets/bifrost_bridge_local_api_key'

docker exec portico-open-webui sh -c \
  'test -s /run/secrets/bifrost_bridge_local_api_key && test -s /run/secrets/owui_auth_bridge_secret && test -s /run/secrets/webui_secret_key'

docker exec mcpo-group-core sh -c \
  'test -s /run/secrets/portico_llm_api_key && test -s /run/secrets/owui_auth_bridge_secret'
```

Do not print secret values. A host file existing does not prove the container mount is valid.

## Core health planes

Require success from all five endpoints:

```bash
curl -fsS --max-time 10 http://127.0.0.1:3789/health
curl -fsS --max-time 10 http://127.0.0.1:4583/health
curl -fsS --max-time 10 http://127.0.0.1:8765/health
curl -fsS --max-time 10 http://127.0.0.1:8766/health
curl -fsS --max-time 10 http://127.0.0.1:3835/health
```

Expected roles:

- `3789`: Open WebUI
- `4583`: LLM gateway
- `8765`: regular MCP/control plane
- `8766`: core MCP plane
- `3835`: chat-state API

Also require healthy container state for MongoDB, Redis, the LLM gateway, and the control plane where health checks are defined.

## UI proof

Use Computer Use against Portico and require:

- the window title is `Portico`
- the shell URL uses `app://bundle`
- the embedded view is on `localhost:3789`
- the New Chat interface and model selector are present
- the focused window is not a loading, retry, or fatal-error screen

An integration-specific "needs attention" badge does not by itself mean packaged startup failed. Identify the integration and preserve its user configuration. Never initiate interactive OAuth merely to make the badge disappear unless the user requests that authentication work.

## Stability and cleanup

After first success, wait at least 60 seconds and repeat:

- app process still alive
- error-log byte delta still zero
- five endpoint checks still pass
- critical containers remain healthy
- app-owned image mismatch count remains zero

Only then remove run-created rollback applications, extracted installers, mounted DMGs, and private temporary environment files. Leave the final application running and preserve unrelated repository files.
