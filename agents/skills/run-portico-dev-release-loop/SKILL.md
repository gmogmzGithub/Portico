---
name: run-portico-dev-release-loop
description: "Execute the complete Portico dev release loop from a normal shell: diagnose and fix blockers, commit and push the exact source, authenticate Harbor without exposing credentials, package with package_for_release.sh, publish the exact ZIP with release_build.sh, install the arm64 DMG, launch the packaged app, and validate logs, signatures, containers, secret mounts, endpoints, and UI. Use when asked to take over a dev build/release/install/launch cycle, reproduce packaged startup failures, or keep iterating until an installed dev build starts cleanly."
---

# Run PORTICO Dev Release Loop

Drive the workflow to a verified installed application, not merely a successful build command.

## Non-negotiable constraints

- Work from the checkout the user supplies. If they do not name one, ask; do not
  assume a path.
- Use normal shell tools for source edits, tests, git, packaging, publishing, artifact inspection, and diagnostics. Do not depend on Zed.
- Use Computer Use only for steps that genuinely require app or browser UI, such as OAuth consent, updater prompts, installer UI, or final visual verification.
- Preserve unrelated worktree changes. Never stage or commit `.report-build/` or report-site output owned by another process.
- Keep credentials out of chat, command output, logs, commits, and process arguments. Use only the user-supplied repository `.env`, the caller environment, or intended secure stores, and never enable shell tracing.
- Treat the repository-root `.env` as protected release-operator input when the user supplies credentials there. Never delete, truncate, rename, or overwrite it during clean-install work, and never substitute a Keychain, broker, cached, or previously exported Cloudsmith value for an assignment already present in that file.
- Prefer targeted installed-app cleanup that leaves the checkout untouched. `clean_dev.sh` and `clean_full.sh` now preserve the repository `.env`, but `clean_full.sh` still removes other ignored output. Treat any `.env` mutation as a fail-closed bug; never move or delete it as part of cleanup.
- Before every package run, commit the intended source, push it, and prove `HEAD` equals its upstream SHA.
- Describe ordinary managed-runtime synchronization as an **update**. Use damage-restoration language only when evidence proves actual corruption and the action truly restores it.
- Do not disable integrations, delete user auth state, or change user configuration merely to make a status indicator green. Separate packaged startup health from integration-specific authentication state.
- Keep iterating through diagnose, patch, test, commit, push, package, publish, install, and launch until the installed app passes the final contract.

## 1. Establish exact state

1. Record the branch, `HEAD`, upstream SHA, worktree status, available disk space, Docker runtime, and installed app build metadata.
2. When the repository `.env` is the credential handoff, verify mode `0600`, record its byte count and SHA-256 digest without reading values into output, and confirm the `CLOUDSMITH_API_KEY` assignment exists. Fail closed if any invariant is missing.
3. Treat the installed bundle, packaged scripts, generated managed runtime, and current app logs as the source of truth. Repo `HEAD` alone is insufficient.
4. Identify unrelated dirty paths before editing and keep them out of every commit.
5. Record launch-log byte baselines immediately before the final launch so earlier failures cannot contaminate the result.

## 2. Diagnose and implement narrowly

1. Locate the exact failing phase: packaging, upload, DMG validation, application launch, managed-runtime update, Docker startup, core sync, or UI load.
2. Inspect the closest real artifact first: build logs, release ZIP, DMG, installed bundle, managed `build-info.json`, fresh app logs, container state, or live endpoint.
3. Fix the smallest owning layer and add targeted regression coverage for every defect found.
4. Run targeted tests while iterating. Run `git diff --check` and the canonical `./run-tests.sh` before declaring source ready.

## 3. Commit and push before packaging

1. Recheck `git status` and stage only intended files.
2. Commit with a specific message. Do not include report output or credentials.
3. Fetch/rebase if the remote moved, rerun required validation after any conflict resolution, and push.
4. Verify `git rev-parse HEAD` and `git rev-parse '@{upstream}'` are identical.
5. If packaging exposes another source defect, return to this step. Never retry packaging from an unpushed commit.

## 4. Package from a normal shell

1. If the user supplied the release credentials in repository `.env`, inspect only its file mode and key names, disable shell tracing, and source that exact file into the caller environment:

   ```bash
   test -f .env
   DOTENV_MODE="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)"
   test "$DOTENV_MODE" = "600"
   grep -Eq '^[[:space:]]*(export[[:space:]]+)?CLOUDSMITH_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' .env
   set +x
   set -a
   source ./.env
   set +a
   ```

   Do not print the file, the assignment, or the resolved value. Do not query or inject a fallback Cloudsmith credential when this check passes.
2. Require these credentials in the inherited environment: `HARBOR_TOKEN`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and `CLOUDSMITH_API_KEY`. `HARBOR_REGISTRY` defaults to `harbor.example.invalid`; `HARBOR_USER` defaults to `USER`.
3. Run the credential-safe preflight in that same environment:

   ```bash
   ./run_dev_release.sh preflight
   ```

4. Package the deterministic build from the pushed commit:

   ```bash
   ./run_dev_release.sh package
   ```

   The runner authenticates Harbor with `--password-stdin`, fixes the command PATH for noninteractive shells, rejects tracked or unpushed source, sets the full SHA and Docker tag explicitly, and creates an exact dev ZIP path.
5. Capture the build number, full commit SHA, ZIP path, image tag, signing result, notarization result, and stapling result without exposing credentials.
6. Confirm the ZIP and both architecture artifacts belong to the pushed SHA. Reject stale or ambiguous output.

## 5. Publish the exact ZIP

Publish only the path produced by the package step:

```bash
./run_dev_release.sh publish "$ZIP_PATH"
```

For a single uninterrupted package-and-publish run, use `./run_dev_release.sh all`. Require exit code zero and verify update discovery sees the exact build before installation.

## 6. Install the arm64 application

1. Extract the exact ZIP into a unique temporary directory.
2. Select the arm64 DMG by its artifact path and validate its build metadata. Do not infer architecture from modification time.
3. Validate the DMG application with `codesign`, Gatekeeper, and `stapler` before replacing `/Applications/Portico.app`.
4. Quit every running Portico process cleanly, retain one temporary rollback copy, install the new application, and validate the installed copy again.
5. Confirm the installed `build-info.json` contains the exact expected build number and full SHA before launch.

## 7. Launch and prove the complete startup path

1. Record fresh byte offsets for the app, error, initialization, and prerequisite logs.
2. Launch `/Applications/Portico.app` and monitor until initialization completes or a concrete failure occurs.
3. Require the app process to remain alive, the control plane to open, and the embedded Open WebUI view to reach New Chat.
4. Validate all managed images use the expected build tag, required runtime secret mounts are nonempty, and every core health endpoint succeeds.
5. Inspect only fresh log segments. Require zero new error-log bytes, one initialization start, one managed-runtime update when expected, one startup core-sync completion, one initialization completion, and one bundled build-info read.
6. Use Computer Use only for the final Portico window inspection. An HTTP health response alone does not prove UI launch.
7. Keep the app running for at least 60 additional seconds, then repeat the process, log-size, endpoint, and container-health checks.

Read [references/validation-checklist.md](references/validation-checklist.md) for detailed validation commands, expected paths, and failure classification rules.

## 8. Finish cleanly

1. Remove only rollback applications, mounted DMGs, extracted temporary directories, and private temporary files created by this run.
2. Leave the verified application installed and running.
3. Recheck the worktree. Preserve the repository `.env`, `.report-build/`, and unrelated user files untouched and uncommitted. If `.env` was protected across cleanup, require its final digest to match the baseline.
4. Report the build number, full SHA, artifact path, upload result, installed signature status, health results, fresh-log invariants, tests, commit, and push.
5. Do not claim completion while any required check is missing, stale, or inferred.
