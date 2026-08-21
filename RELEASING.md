# Releasing

This project now ships users a prebuilt, signed, notarized macOS app bundle and DMG. Users do not install with `bootstrap.sh` anymore.

The installed app lives at `/Applications/Portico.app`.

The managed runtime tree still lives at:

```text
~/portico/portico-managed
```

That managed tree continues to hold MCP configs, toggles, skills, compose inputs, and runtime metadata.

## What A Release Contains

Each release upload is a single Cloudsmith raw zip payload. That payload includes:

- `release-manifest.json`
- `runtime-image-attestation.json` for GitLab-built releases
- `managed-root/`
- `artifacts/apps/darwin-arm64/Portico.app`
- `artifacts/apps/darwin-x64/Portico.app`
- `artifacts/dmg/darwin-arm64/...`
- `artifacts/dmg/darwin-x64/...`
- `host-mcp-binaries/`

During update preparation, the app downloads this payload, stages the managed runtime tree, and selects the correct native `.app` and `.dmg` for the user’s Mac.

## Release Channels

Choose the release channel based on who should receive the build:

- `dev`: internal development/testing builds. Use this for fast iteration and high churn.
- `beta`: pre-release validation with a broader but still controlled audience.
- `stable`: production release for general users.
- a custom slug: isolated team or experiment builds that should not appear on
  Stable, Beta, or Development.

The channel determines the Cloudsmith raw package name:

- `stable` -> `portico`
- `beta` -> `portico_beta`
- `dev` -> `portico_dev`
- `team-alpha` -> `portico_team-alpha`

Custom slugs are trimmed and lowercased. They must contain 1–64 lowercase
letters, digits, hyphens, or underscores, with an alphanumeric first and last
character. `stable`, `beta`, and `dev` are reserved for their built-in channel
options.

Clients on a given channel only look for updates from that channel’s package.

## Prerequisites

Run the packaging step on a macOS host when you want the script to build the macOS artifacts itself.

Before packaging a release, make sure you have:

- Apple signing credentials installed in your macOS keychain
- notarization env vars set:
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`
- Docker running
- Harbor auth configured so runtime images can be pushed
- a read-only `CLOUDSMITH_ENTITLEMENT_TOKEN`; packaging resolves the first
  nonblank value from the release environment, the source `cloudsmith.env`, or
  the release operator's macOS Keychain (service `portico`, account
  `CLOUDSMITH_ENTITLEMENT_TOKEN` by default). This is mandatory and is embedded
  in the signed app and managed-runtime bootstrap resource so first-launch
  update/repair can authenticate. Override the Keychain coordinates with
  `PORTICO_LLM_KEYCHAIN_SERVICE` and
  `CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT`. CI and non-macOS builds must supply
  the token explicitly through the environment or source file; never commit it.
- a `CLOUDSMITH_API_KEY` for packaged update discovery and release upload:
  - usually via the release operator's `cloudsmith.env`
  - or in the packaging/upload command environment
  - packaging embeds it in the signed app resource for Cloudsmith package-list
    requests; runtime child environments and orchestrated containers still
    exclude it
- Node/npm available

`package_for_release.sh` also builds and publishes the runtime Docker images for the release tag by default.
It fails closed when either Cloudsmith credential is absent or blank, and validates
that every reused or newly built app contains the same prepared updater configuration.
The API key is readable from the signed app bundle by design, matching the updater
contract used by `beta-latest`; the entitlement token remains the download credential.

## Pick A Build ID

The build id format is:

```text
MMDDYYYY-<short-sha>
```

Example:

```bash
03102026-deadbeef
```

Use the same build id consistently for:

- the payload zip name
- the release manifest `buildNumber`
- the runtime Docker image tag for local releases

Protected GitLab releases currently use the release build id as the runtime
image tag, matching local releases. The bundled image attestation binds that
tag to the full source revision, the seven runtime image indexes, and both
native Linux platform digests. The accepted automatic Dev-channel contract and
its relationship to Beta are documented in
[`docs/development/dev-channel-release-pipeline.md`](docs/development/dev-channel-release-pipeline.md).

If you do not pass a build id to `package_for_release.sh`, it now suggests one automatically using:

- today’s date from the local machine
- the short SHA of `HEAD` from the local git checkout

Example suggested value:

```bash
03092026-2a10b9b7
```

Interactive behavior:

- if you pass a build id explicitly, the script uses it
- if you omit it and run interactively, the script asks for confirmation
- if you omit it in non-interactive mode, the script prints the suggested value and exits unless you pass `--yes`

## GitLab CI/CD

`.gitlab-ci.yml` keeps merge-request source code and release credentials in
separate projects:

- every same-project merge request runs `./run-tests.sh` and then mirrors the
  protected `portico/portico-release-broker` pipeline. Forks are
  rejected. The broker publishes every successful MR commit to custom channel
  `mr-<IID>` / package `portico_mr-<IID>` with runtime tag
  `mr-<IID>-<full-sha>`. The mirrored trigger holds a per-IID resource lock for
  the complete broker run while unrelated merge requests remain concurrent;
- the broker builds untrusted MR source without Apple or Cloudsmith credentials.
  Its protected signing job consumes only bounded staged artifacts and trusted
  tooling, signs/notarizes both apps and DMGs, revalidates the current MR head,
  and publishes without promoting MR images to `latest`;
- protected pushes to `pre-beta-tmp` and `beta` run the canonical test gate, publish all
  seven runtime images under the full commit SHA for `linux/amd64` and
  `linux/arm64`, validate their labels and digests into a bounded attestation,
  and build the signed/notarized payload once for both macOS architectures.
- `pre-beta-tmp` push pipelines continue to publish `dev` automatically. When
  starting a `pre-beta-tmp` pipeline manually, change the prefilled
  `portico_RELEASE_CHANNEL` variable to publish `dev` or any valid custom channel.
  The channel is validated in metadata before signing, so the selected channel
  is baked into both app bundles and DMGs. `stable` and `beta` are rejected on
  `pre-beta-tmp`.
- Cloudsmith publication revalidates the exact ZIP and checks that the commit is
  still the protected branch tip. Publication is serialized and retryable.
  Only after it succeeds are the seven attested image indexes promoted to
  `latest`, with a second branch-tip and digest check.

The CI path is additive. Existing local `preflight`, `package`, `publish`, and
`all` behavior in `run_dev_release.sh` is unchanged unless the new CI-specific
options are explicitly supplied. Local packaging still performs its existing
Docker/Harbor build-or-reuse flow and local signing/notarization checks.
`stage-mr` is the credential-free broker-only command and refuses release
credentials or the repository `.env` handoff.

Before enabling release pipelines, complete these project-level prerequisites:

- protect `pre-beta-tmp` and `beta` (`pre-beta-tmp` serves as the dev channel);
- enable `shared-pure`, native `amd64`, and native `arm64` runners;
- ask MAP to link the `map-macos-vm` runner and keep the CI image pinned to
  `tahoe-26-4-1-xcode-26-5`;
- the `portico` Vault namespace provides two GitLab roles: `release`
  (bound to `portico/portico`, `ref_protected=true`) and
  `release-broker` (bound to `portico/portico-release-broker`,
  `ref_protected=true`). These are defined declaratively in
  `consul-vault/vault-namespaces` under `groups/portico.yaml`;
- store these fields in secret unit `gitlab-ci/release-secrets`:
  `APPLE_CODESIGN_P12_BASE64`, `APPLE_CODESIGN_P12_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `CLOUDSMITH_API_KEY`, and
  `CLOUDSMITH_ENTITLEMENT_TOKEN`;
- configure `HARBOR_USER` and `HARBOR_TOKEN` as protected, masked, raw GitLab
  variables. Use a Harbor robot account and disable variable expansion so a
  `$` in the username is preserved;
- verify the imported certificate resolves exactly to
  `Developer ID Application: Portico, Inc. (AJDA86F3YP)`.

For signed MR releases, copy `ci/release-broker-project/` into the dedicated
broker project and complete its README setup. Protect broker `main`, configure
reciprocal fine-grained job-token access, bind the broker Vault role only to its
protected `main`, and add a daily `portico_CLEANUP_ONLY=true` schedule. The pinned
container-image child pipeline requires `HARBOR_USER` and `HARBOR_TOKEN` as
protected, masked, raw broker variables; GitLab trigger jobs cannot resolve
job-scoped Vault secrets. Configure the application's numeric project ID as the
protected, non-secret `portico_SOURCE_PROJECT_ID` broker variable for scheduled
cleanup. Backport the application `.gitlab-ci.yml` trigger to
maintained source branches because repository-local YAML cannot enforce the
broker on branches that do not contain it.

The cleanup retains the newest release for every open MR, removes superseded or
closed-MR releases after seven days, and deletes their MR-specific Harbor tags
only after the complete Cloudsmith/GitLab/Harbor deletion plan validates.

`CLOUDSMITH_API_KEY` is still embedded for update discovery and also performs
publication, including MR releases. This preserves the selected existing-key
contract but means an upload-capable key is extractable from every distributed
MR app. Monitor and rotate it accordingly; do not broaden its permissions
further. The entitlement token remains the separate read/download credential.

## Recommended Flow

### 1. Package the release payload

Beta example:

```bash
./package_for_release.sh --channel beta
```

Stable example:

```bash
./package_for_release.sh --channel stable
```

Dev example:

```bash
./package_for_release.sh --channel dev
```

Custom example:

```bash
./package_for_release.sh --channel team-alpha
```

This creates:

- `release/portico_beta-03102026-deadbeef.zip`
- or the stable/dev equivalent for the chosen channel
- custom channels use the same pattern, for example
  `release/portico_team-alpha-03102026-deadbeef.zip`

It also:

- stages `managed-root/`
- builds or reuses both macOS app architectures
- builds or reuses both DMGs
- builds host MCP binaries
- writes `release-manifest.json`
- publishes the runtime Docker images for the release tag

On macOS, the final payload ZIP is created with the built-in
`/usr/bin/ditto` tool using AppleDouble metadata sidecars. This preserves the
extended attributes required by signed application bundles; `ditto` ships with
macOS and does not require Xcode, Command Line Tools, or Homebrew. Packaging
then extracts the completed partial ZIP and revalidates both app signatures and
all app/DMG notarization tickets before atomically replacing the final ZIP.

Useful options:

- `--full-sha <sha>` to force the full git SHA in metadata
- `--docker-image-tag <tag>` to override the runtime image tag
- `--output-zip <path>` to choose a custom output path
- `--yes` to auto-accept the suggested build id when you omit it
- `--force-docker-images` to rebuild every runtime image even when the exact release tag is already valid
- `--app-arm64`, `--app-x64`, `--dmg-arm64`, `--dmg-x64` to reuse prebuilt artifacts
- `--host-mcp-binaries-dir <dir>` to reuse an existing `host-mcp-binaries` tree
- failed runs preserve the staged temp tree by default; set `PACKAGE_FOR_RELEASE_KEEP_TEMP_ON_FAILURE=false` if you explicitly want cleanup on failure

By default, packaging validates every exact-tag runtime image in Harbor. A clean
source tree reuses images that already contain both `linux/amd64` and
`linux/arm64`, builds only missing or invalid images, and synchronizes reused
images to `latest`. Newly built images include source-revision and build-version
labels. Dirty source trees rebuild the complete image set rather than reusing a
tag whose contents may not match the workspace.

If you intentionally do not want to build/publish Docker images during packaging,
use the existing skip environment variable. Skip mode still fails closed unless
every exact-tag image is present and valid, but it does not update `latest`:

```bash
PACKAGE_FOR_RELEASE_SKIP_DOCKER_IMAGES=true ./package_for_release.sh 03102026-deadbeef --channel beta
```

For targeted recovery outside the packaging wrapper, `build_docker_images.sh`
accepts `--images` with canonical comma-separated image names and
`--source-revision` with the full Git SHA. Builds use the versioned
`portico-multiarch-v030` builder backed by `moby/buildkit:v0.30.0` by
default; `BUILDX_BUILDER` and `BUILDKIT_IMAGE` remain available as overrides.
Recognized network failures receive two total attempts by default. Override that
with `DOCKER_BUILD_MAX_ATTEMPTS` and `DOCKER_BUILD_RETRY_DELAY_SECONDS` when
diagnosing a build host.

The Rust release Dockerfiles persist both Cargo downloads and compiled target
artifacts in the BuildKit builder. The MCP runtime, control plane, and health
check use one identical compiler stage that builds their shared Cargo workspace
once, then reuse that complete stage. Its incremental cache is keyed by Rust
version, libc, and target architecture; the musl Bifrost bridge remains
isolated. Keep the versioned builder between release runs; deleting it also
deletes these warm compilation caches.

### 2. Dry-run the Cloudsmith upload

```bash
./release_build.sh release/portico_beta-03102026-deadbeef.zip --channel beta --dry-run
```

For a custom channel, both the filename and `--channel` value must match:

```bash
./release_build.sh release/portico_team-alpha-03102026-deadbeef.zip --channel team-alpha --dry-run
```

This validates:

- the payload filename
- the derived package name
- the chosen channel

### 3. Upload the payload

```bash
./release_build.sh release/portico_beta-03102026-deadbeef.zip --channel beta
```

Always upload through `release_build.sh`, including dev builds. It repeats the
final ZIP signature and notarization validation before any Cloudsmith replace
or upload operation. A direct `cloudsmith push raw` bypasses this release gate.

The upload is not visible to automatic update selection until publication is
complete. `release_build.sh` waits for Cloudsmith synchronization, downloads the
exact ZIP through the same entitlement URL that clients use, and verifies its
size and SHA-256 against the signed local ZIP. It then adds the immutable
`portico-update-ready-v1` tag to that exact package. The release job fails and leaves
the package unmarked if any step fails. Payload verification waits for at most
15 minutes by default; rerunning the release resumes verification without an
upload when Cloudsmith already has the same bytes. Latest-build discovery
accepts only marked packages; exact-build recovery remains available for older
unmarked packages.

This producer and consumer contract must ship together. During the first
contract-bearing release, already-installed clients that predate the marker can
still discover the package before verification finishes. Do not publish that
release with a direct Cloudsmith command, and do not deploy the consumer filter
without the matching release job.

If you must replace an existing raw package with the same version:

```bash
./release_build.sh release/portico_beta-03102026-deadbeef.zip --channel beta --replace
```

## Compatibility Wrapper

`release_beta_build.sh` still exists, but it is now just a wrapper around:

1. `package_for_release.sh`
2. `release_build.sh`

Example:

```bash
./release_beta_build.sh 03102026-deadbeef
```

The compatibility wrapper also accepts custom channels:

```bash
./release_beta_build.sh 03102026-deadbeef --channel team-alpha
```

The normal-shell release runner remains Development by default and can target
a custom channel explicitly:

```bash
./run_dev_release.sh all 03102026-deadbeef --channel team-alpha
```

Use `package_for_release.sh` and `release_build.sh` directly for new automation.

## Which Channel Should I Use?

Use `dev` when:

- the build is mainly for engineers
- you expect multiple follow-up fixes
- you do not want wider beta users to see it yet

Use `beta` when:

- the build is expected to be close to production
- you want broader validation
- you still want to protect stable users from churn

Use `stable` when:

- beta validation is complete
- the build is the one you want normal users to receive
- the app/managed runtime payload and Docker images are all final for rollout

## Notes

- Do not upload a payload to the wrong channel and assume clients will sort it out. Channel selection is entirely driven by the Cloudsmith package name.
- The payload always contains both macOS architectures. The app chooses the correct one at update time.
- In-app updates only auto-apply for installs running from `/Applications/Portico.app`.
- Legacy managed-dist installs must do a one-time manual DMG install before they can use the new in-app update path.
