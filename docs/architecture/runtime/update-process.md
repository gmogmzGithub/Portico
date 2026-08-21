# Desktop Update Process

This document describes the macOS desktop update path for the managed install at
`~/portico/portico-managed`, including preparation, backup placement,
managed-runtime reconciliation, and the ownership split between application
payload files and user/runtime-generated data.

## Terms

- **Managed directory**: the active managed runtime tree at
`~/portico/portico-managed`.
- **Preparation directory**: an isolated staging directory under
`~/Library/Application Support/portico/update-prep/<update-key>/`.
- **Prepared update payload**: the downloaded and verified release archive after
extraction into the preparation directory. Its `managed-root/` subtree is the
release's intended application-managed runtime tree.
- **Prepared managed root**: the extracted payload directory recorded in the
preparation manifest as `managedRootDir`, normally
`<prep>/payload/managed-root`.
- **Preserved paths**: local config and user/runtime-generated paths that remain
in place inside the managed directory while app-owned files are reconciled from
the verified prepared payload.

## Step-by-step update flow

### 1. Electron selects an update candidate

The app sees:

```text
current: 05282026-c2bf1c8a
latest:  06162026-c2b6f481
channel: portico_beta
```

Then it resolves a Cloudsmith update candidate and launches the preparation helper with the download URL, filename, checksum, update key, channel, and last-modified metadata.

The channel field is always the raw package identity. Built-in examples are
`portico`, `portico_beta`, and `portico_dev`; a custom
selection such as `team-alpha` uses `portico_team-alpha`. The same
identity is carried through discovery, prepared-update validation, prerequisite
recovery, and reinstall/specific-build flows.

The rest of the update is split into two phases:

- **Prepare**: download, verify, extract, and inspect everything in an isolated
preparation directory without mutating the active managed install.
- **Apply**: install the already-prepared artifacts into the managed install,
reconcile app-owned files, protect user/runtime data, regenerate runtime files,
and then mark the app ready for restart.

### 2. Preparation creates an isolated update-prep directory

`prepare-update-cloudsmith.sh` creates a preparation directory outside the
managed install. A typical path is:

```text
~/Library/Application Support/portico/update-prep/<update-key>/
```

For example, a prepared update seen in logs may look like:

```text
/Users/<user>/Library/Application Support/portico/update-prep/06162026-c2b6f481_sha256_b370f54443c27f68b713cedd2341b361fb3ad98c0fc140815da5e03276b1bc9d_portico_beta/
```

Inside that preparation directory, the important paths are:

- `download/`: downloaded archive and temporary extraction output.
- `payload/`: normalized extracted release payload.
- `backup/`: prepared full-backup archive.
- `manifest.json`: the prepared update manifest consumed by the apply step.

The preparation script refuses to run if the staging directory is inside the
managed directory, so partially prepared files cannot overwrite the active app.

### 3. Preparation creates a full backup before any managed mutation

If the managed directory exists, preparation creates a full backup zip in the
preparation directory before the apply step is allowed to mutate the managed
install.

The backup path is:

```text
<update-prep>/backup/portico_full_backup_<timestamp>.zip
```

For example:

```text
/Users/<user>/Library/Application Support/portico/update-prep/06162026-c2b6f481_sha256_b370f54443c27f68b713cedd2341b361fb3ad98c0fc140815da5e03276b1bc9d_portico_beta/backup/portico_full_backup_1781653852.zip
```

This backup uses `zip -r --symlinks`, not rsync. It includes user/runtime data
such as `open-webui-data/`, while excluding bulky/generated app artifacts and
existing backup archives:

```bash
zip -r --symlinks "$PREP_FULL_BACKUP_PATH" "$MANAGED_BASENAME" \
  -x "$MANAGED_BASENAME/electron-app/node_modules/*" \
  -x "$MANAGED_BASENAME/electron-app/dist/*" \
  -x "$MANAGED_BASENAME/electron-app/dist-update/*" \
  -x "$MANAGED_BASENAME/electron-app/dist-backup/*" \
  -x "$MANAGED_BASENAME/electron-app/dist-update-prepared/*" \
  -x "$MANAGED_BASENAME/backup/*"
```

This prepared backup is a recovery artifact for the pre-update managed tree. The backup is meant to protect user/runtime data. It is independent from the later reconcile rsync path and is not the mechanism used to apply the update.

### 4. Preparation downloads the release archive

Preparation downloads the Cloudsmith archive into:

```text
<update-prep>/download/<release-file>.zip
```

The helper emits machine-readable progress markers while downloading so the UI  
can report progress. If the download fails with retryable curl failures, the  
prepare helper can retry with a clean environment.

### 5. Preparation verifies the downloaded archive

After download, preparation computes the declared checksum and compares it with
the expected value passed by Electron. If the checksum does not match,
preparation fails before extraction or apply.

### 6. Preparation extracts and normalizes the payload

The verified archive is unzipped into:

```text
<update-prep>/download/extract/
```

The extracted contents are then normalized into a structure like this:

```text
<update-prep>/payload/
  release-manifest.json
  managed-root/
  artifacts/
    apps/darwin-arm64/Portico.app
    dmg/darwin-arm64/Portico-1.0.0-arm64.dmg
```

The payload must contain `release-manifest.json`. Legacy source payloads are no
longer accepted for staged desktop installs.

### 7. Preparation identifies the prepared managed root

The release manifest tells preparation where the release's managed runtime tree
lives. Usually this is:

```text
<update-prep>/payload/managed-root
```

This directory is the **prepared managed root**. It is the application-managed
tree from the new release: scripts, Docker files, app-owned MCP configs,
packaged skills, Electron app resources, and similar shipped files.

It should not intentionally contain user/runtime-owned directories such as
`open-webui-data`. Packaging excludes those paths; during apply, root-anchored
rsync filters hide any same-named payload path and protect the local managed copy
from deletion or overwrite.

### 8. Preparation selects and verifies native macOS artifacts

Preparation selects the app bundle and DMG for the native macOS architecture
from the release manifest. It verifies their signatures and ensures the prepared
managed root has `electron-app/build-info.json`, creating it if required.

Preparation then writes `<update-prep>/manifest.json`, which records paths such
as:

```json
{
  "managedRootDir": "<update-prep>/payload/managed-root",
  "selectedAppBundle": "<update-prep>/payload/<app-bundle-path>",
  "selectedDmg": "<update-prep>/payload/<dmg-path>",
  "buildInfoPath": "<update-prep>/payload/managed-root/electron-app/build-info.json",
  "fullBackupPath": "<update-prep>/backup/portico_full_backup_<timestamp>.zip"
}
```

At this point, the active managed install has still not been modified.

### 9. Apply validates the prepared manifest and artifacts

`apply-prepared-update.sh` reads the prepared manifest paths and validates:

- prepared managed runtime exists
- prepared app bundle exists
- prepared DMG exists
- prepared build-info exists
- app bundle build-info matches staged build-info

It also validates the prepared app bundle resources and removes generated compose files from the prepared managed root, because those files are regenerated after install.

### 10. Apply places the prepared backup into managed `backup/`

Before reconciling the runtime tree, apply places the prepared full backup into
the managed install's backup directory:

```text
~/portico/portico-managed/backup/portico_full_backup_<timestamp>.zip
```

Apply first tries to hard-link the prepared backup into managed `backup/`. If
that is not possible, it copies the zip. The log line therefore says either:

```text
Prepared backup linked to ~/portico/portico-managed/backup/portico_full_backup_<timestamp>.zip
```

or:

```text
Prepared backup copied to ~/portico/portico-managed/backup/portico_full_backup_<timestamp>.zip
```

Backup retention then keeps the newest matching full backup archives.

### 11. Apply reconciles the prepared managed root into the managed install

`apply-prepared-update.sh` calls:

```bash
managed_runtime_reconcile_payload "$PREPARED_MANAGED_ROOT_DIR" "$MANAGED_DIR" "${PRESERVE_FILES[@]}"
```

Conceptually:

```text
prepared managed root:
  <update-prep>/payload/managed-root   <- new app/runtime files

managed directory:
  ~/portico/portico-managed   <- existing installed runtime with user data
```

This is the only step that replaces app-owned files in the active managed runtime tree.

### 12. Reconcile defines the preserved path set

`PRESERVE_FILES` means "must survive an update". The reconcile helper protects
these paths in place with root-anchored rsync filter rules rather than copying
them through a temporary merged tree.

The default preserve list contains local config files and user/runtime-generated
directories:

- `.env`
- `.env.runtime`
- `HOST_MODE`
- `open-webui-data`
- `mcp-configs-user`
- `mcpo-oauth-tokens`
- `mcpo-core-oauth-tokens`
- `UPDATE_CHANNEL`
- `artifact-snapshots`
- `skills-marketplace`
- `skills-user`
- `mcp_toggles.json`
- `mcp_tools_config.json`
- `marketplaces.json`
- `workspaces`
- `backup`

This list includes user/runtime-owned directories that may contain large files,
database state, OAuth token stores, downloaded marketplace skills, and workspace
content. Those paths are backed up by the prepared full backup, then left in
place during reconcile.

### 13. Reconcile validates preserve paths

Before syncing, reconcile rejects unsafe preserve path entries. Preserve paths
must be top-level relative literal names; absolute paths, nested paths, trailing
slashes, `.`/`..` path components, and glob metacharacters are rejected before
the managed directory is mutated.

This keeps the rsync filters rooted inside the managed directory and prevents a
malformed preserve entry from broadening what the update protects or deletes.

### 14. Reconcile syncs app-owned payload files in place

Reconcile then syncs the verified prepared managed root directly into the
managed directory with rsync:

```bash
rsync -a --delete --force \
  --filter="H /.env" --filter="P /.env" \
  --filter="H /.env/***" --filter="P /.env/***" \
  --filter="H /open-webui-data" --filter="P /open-webui-data" \
  --filter="H /open-webui-data/***" --filter="P /open-webui-data/***" \
  ... \
  "$PREPARED_MANAGED_ROOT_DIR"/ "$MANAGED_DIR"/
```

Important behavior:

- `-a` preserves normal file metadata while recursively syncing.
- `--delete` removes destination files that are not present in the prepared
  payload, so stale app-owned files from old releases are removed.
- `--force` allows rsync to delete destination directories when the source has a
  file at the same path.
- `H` filter rules hide preserved paths from the prepared payload, so an
  accidental payload placeholder under a preserved path is not copied over local
  user/runtime state.
- `P` filter rules protect existing preserved destination paths from deletion
  during `--delete`.

Reconcile now requires rsync for this safety property. If rsync is unavailable,
the update fails closed rather than clearing the managed directory and relying on
copied preserved state.

### 15. Preserved paths are not copied during reconcile

Preserved paths such as `.env`, `open-webui-data/`, token stores,
`workspaces/`, user skills, marketplace state, and `backup/` remain at their
existing managed-directory paths throughout reconcile. Their inodes,
permissions, ACLs/xattrs, and actively written files are not copied out to a
temporary directory and copied back during normal update application.

### 16. Apply installs metadata and regenerates runtime files

After the managed runtime tree is reconciled, apply writes the prepared
`build-info.json`, regenerates compose/MCP runtime artifacts, validates the
result, records the last installed Cloudsmith timestamp, and signals that the app
is ready for restart.

## Why preserved paths are protected in place

The reconcile helper syncs the verified prepared payload directly into the
managed directory while using rsync filters to keep preserved paths out of the
source transfer and protected from destination deletion.

That design keeps the useful properties of the previous merged-tree reconcile:

- A full pre-update zip backup is created before mutation.
- The sync can still use `--delete` to remove stale app-owned files.
- Preserved local config and user/runtime data survive even when the prepared
  payload does not contain those paths.
- If a release accidentally includes a same-named preserved path, the payload
  path is hidden and the local preserved path remains authoritative.

It also avoids the previous tradeoff where update application depended on
successfully copying every preserved path twice: from managed to `preserved/`,
then from `preserved/` to `staged/`. Large user data directories and
user-originating filenames no longer need to be duplicated before app-owned files
can be reconciled.

## Rollback and recovery

The updater has recovery artifacts and downgrade entry points, but it does not
currently implement fully automatic health-check rollback.

### Supported rollback paths

1. **Install Specific Build**

   If a known-good earlier build still exists in the current Cloudsmith channel,
   use **Help → Install Specific Build…** and enter that build ID. The install
   specific flow uses the same preparation, checksum verification, backup,
   reconcile, and restart path as a forward update.

2. **Reinstall Latest Build**

   Use **Help → Reinstall Latest Build…** when the latest channel build is known
   good but the local installation appears corrupted or incomplete. This does
   not roll back to an older version; it reapplies the latest available payload.

3. **Restore the managed runtime backup manually**

   Before apply mutates the managed directory, preparation creates a full backup
   archive and apply places it under:

   ```text
   ~/portico/portico-managed/backup/portico_full_backup_<timestamp>.zip
   ```

   This archive can be used by support/engineering to restore the pre-update
   managed runtime tree. It excludes bulky generated app artifacts such as
   `electron-app/node_modules`, `electron-app/dist*`, and previous backup
   archives, so it should be treated as a managed-runtime/user-data recovery
   artifact rather than a complete byte-for-byte clone of every generated file.

4. **App bundle swap failure recovery**

   The `/Applications` bundle installer keeps a temporary backup of the previous
   app bundle while promoting the staged bundle. If the helper errors after the
   old app is moved out of the way but before the new app is promoted, the error
   trap restores the previous app bundle. After a successful promotion, that
   temporary app-bundle backup is removed.

### Not currently automatic

- There is no post-update health gate that detects a bad app launch and restores
  the previous Cloudsmith build automatically.
- There is no automatic restore of the managed runtime backup when a newly
  installed build starts but later fails a runtime health check.
- There is no retained previous `/Applications` app bundle after a successful
  app-bundle promotion; rollback to an earlier application bundle should use
  **Install Specific Build…** or a manually retained DMG/app artifact.

### Practical rollback runbook

When a release is suspected bad:

1. **Stop rollout at the source**: remove, replace, or supersede the bad
   Cloudsmith package for the affected channel. Clients choose candidates by
   Cloudsmith package name and build/timestamp ordering.
2. **Publish a fixed forward build** when possible. This is usually safer than
   asking every user to downgrade, because normal update checks will converge on
   the latest channel candidate.
3. **Use Install Specific Build** for individual users who must return to a
   known-good older build before a fixed forward build exists.
4. **Use the managed backup archive** only when user/runtime state must be
   restored to its exact pre-update state. Coordinate with the user because this
   can overwrite changes made after the update.
5. **Collect logs before destructive recovery**. The update logs and prepared
   manifests usually identify whether the failure happened during check,
   preparation, apply, app-bundle install, or first launch.

## Data safety guarantees and limits

The updater is designed to avoid corrupting user data, but it is a file-based
update process rather than a transactional database migration system.

### What the updater protects

- It creates a full managed-runtime backup before active managed files are
  mutated.
- It refuses payloads without checksum metadata and verifies the downloaded file
  before extraction.
- It verifies the selected app bundle and DMG signatures during preparation.
- It separates app-owned payload files from user/runtime-owned paths.
- It protects configured preserved paths in place with rsync hide/protect
  filters.
- It lets `rsync --delete` remove stale app-owned files while preventing
  deletion or overwrite of user/runtime state.
- It revalidates Cloudsmith before apply to avoid installing stale prepared
  snapshots.

### Residual risks

- If the system loses power, the disk fills, or the machine is killed during the
  final managed-runtime sync, the managed directory can be left partially
  updated. The pre-update backup archive is the recovery path.
- If runtime data is actively being written while the backup archive is created,
  the backup may reflect the filesystem at that moment rather than an
  application-level quiesced snapshot.
- If a new app version performs a destructive or buggy database/schema migration
  after launch, the update layer itself will not automatically roll that
  migration back.
- Manual restoration from backup can overwrite user changes made after the
  backup timestamp.

For these reasons, risky releases should prefer beta/dev channel validation and
forward-fix rollouts over relying on emergency manual backup restoration.

## Logs and artifacts to inspect

Useful files during update triage:

| Artifact | Typical location | Purpose |
| --- | --- | --- |
| Preparation state | `~/Library/Application Support/portico/update-prep/state.json` | Current or last persisted preparation state. |
| Preparation manifest | `~/Library/Application Support/portico/update-prep/<update-key>/manifest.json` | Paths to prepared managed root, app bundle, DMG, backup, checksum, and timestamp. |
| Preparation logs | `~/Library/Application Support/portico/logs/update-prep-YYYY-MM-DD.log` | Download, verify, extraction, signature, Docker preparation, and failure markers. |
| Apply logs | `~/Library/Application Support/portico/logs/update-YYYY-MM-DD.log` | Main apply script stdout/stderr and `READY_FOR_RESTART` status. |
| App-bundle install logs | `~/Library/Application Support/portico/logs/update-app-install-YYYY-MM-DD.log` | `/Applications` bundle replacement and relaunch results. |
| Managed backup archives | `~/portico/portico-managed/backup/portico_full_backup_*.zip` | Pre-update managed-runtime recovery archives. |
| Installed build state | `~/Library/Application Support/portico/LAST_INSTALLED_BUILD` | Build-bound JSON (`buildNumber` plus Cloudsmith timestamp) used for same-build reuploads and same-day SHA ordering. |

For a failed update, first identify the phase:

- **No update shown**: inspect channel, Cloudsmith package name, build ID format,
  and checksum metadata.
- **Preparation failed**: inspect `update-prep-YYYY-MM-DD.log`, checksum/signature
  failures, missing `release-manifest.json`, missing native artifacts, Docker
  preparation failures, or payload extraction/normalization errors.
- **Apply failed**: inspect `update-YYYY-MM-DD.log`, prepared key mismatch,
  missing prepared artifacts, managed-runtime reconcile failures, compose
  regeneration failures, or non-canonical `/Applications` install errors.
- **Relaunch failed**: inspect `update-app-install-YYYY-MM-DD.log`, permissions
  under `/Applications`, staged bundle existence, and Gatekeeper/codesign status.
