# PORTICO-418: Automatic Dev-channel release pipeline

**Status:** Implemented; operational rollout pending.

**Tracked by:** [PORTICO-418: Add CI pipeline for dev](https://portico.atlassian.net/browse/PORTICO-418)

This document defines the detailed CI/CD and operational contract behind the
automatic Dev-channel builds described in the
[branching strategy](branching-strategy.md). The branching strategy is the
desired state; this document records how the Dev pipeline must differ from the
current Beta pipeline and which setup belongs outside the pipeline YAML.

## Decision summary

- Every push to the protected `dev` branch triggers a full release build.
- Only the latest viable Dev push publishes to the `portico_dev`
  Cloudsmith channel.
- Superseded build, test, image, and package jobs are interruptible. Publication
  is serialized and is not interrupted after external mutation begins.
- A stale Dev publisher exits successfully without publishing. A stale Beta
  publisher continues to fail closed.
- Dev releases are signed and notarized, but do not upload to PORTICO-Service,
  promote global Harbor `latest`, publish GitLab Pages, or run Beta/custom
  release gates.
- A packaged release uses an exact Harbor image tag recorded as
  `dockerImageTag`; it never consumes global `latest`.
- The `dev` branch must be protected before release credentials can be used.
- Dev/Beta retention cleanup is scheduled CI/CD automation, but is not part of
  every release pipeline DAG.
- The release broker remains the merge-request trust boundary and does not run
  protected Dev or Beta releases.

## Latest-viable-push publication semantics

The Dev branch is expected to move frequently. New pushes should cancel work
that has not reached a release side effect, while publication must not be killed
in the middle of an external mutation.

```text
New push to dev
      |
      +-- Cancel older interruptible build/test/package jobs
      |
      v
Latest pipeline reaches serialized publisher
      |
      +-- Branch HEAD changed? --> successful no-op
      |
      +-- Still current? -------> publish Dev package
```

The implementation must provide the following behavior:

1. Parent-pipeline build, test, host-binary, runtime-image, verification, and
   package jobs are interruptible.
2. The runtime-image child pipeline also declares `default: interruptible:
   true`; parent defaults do not automatically make every child job
   interruptible.
3. Dev publication uses a dedicated resource group so Dev releases do not block
   manually selected Beta releases.
4. The Dev resource group's process mode is configured as `newest_first` in
   GitLab so the newest waiting publisher is considered before older waiting
   publishers.
5. After acquiring the publication lock, a Dev publisher compares its source
   revision with the current remote `dev` tip. If it is stale, it reports the
   reason and exits zero without mutating Cloudsmith.
6. Cloudsmith publication is `interruptible: false` and remains under the lock
   until upload and package discovery are complete.

Once a Cloudsmith upload has actually begun, it should be non-interruptible. If
a new push arrives during that short interval, the older upload may finish, but
the next successful Dev pipeline supersedes it. Killing a publisher in the
middle of an external mutation is less safe than allowing that temporary state.

If pushes arrive faster than the full build can complete, superseded pipelines
may all be cancelled and no release will publish until one push remains current
long enough to reach publication. This is expected for a latest-viable-push
policy.

## How Dev differs from Beta

| Behavior | Dev | Beta |
| --- | --- | --- |
| Trigger | Every protected `dev` push | Pipeline on protected `beta`; publication remains manual |
| Earlier build jobs | Interruptible and cancelled by newer pushes | May continue until manually selected |
| Stale publisher | Exit successfully without publishing | Fail closed because a manually selected release moved |
| Cloudsmith | Automatically publish `portico_dev` | Manual Beta gate |
| Signing and notarization | Required | Required |
| PORTICO-Service upload | No | Yes |
| Global Harbor `latest` | No | Retain current Beta promotion for now |
| Custom-channel release gates | No | Available from protected Beta |
| GitLab Pages | No | Retain current behavior for now |
| Slack users seed | No | Retain the optional Beta behavior |
| Publication resource group | Dedicated serialized Dev publication | Existing Beta release lock |

The Dev pipeline should reuse the existing full release build path for tests,
host binaries, dual-architecture runtime images and attestation, and signed and
notarized application artifacts. It should differ only where channel cadence,
publication policy, or downstream audience requires different behavior.

The Beta branch-tip assertion is intentionally strict because a human selected
that release. The Dev equivalent is intentionally a successful no-op because a
newer push is a routine condition, not a failed release.

## Cloudsmith and Harbor release identity

Under the current executable CI contract, protected releases use:

```text
RELEASE_IMAGE_TAG=$RELEASE_BUILD_ID
MMDDYYYY-<short-sha>
```

For example:

```text
08102026-1a2b3c4d
```

That exact tag is embedded as `dockerImageTag` in the package. Runtime startup
reads it rather than `latest`. Dev should publish all seven runtime images for
both supported Linux architectures under that exact release tag.

Dev should not promote global `latest` because:

- `latest` is one mutable alias shared by all channels.
- Frequent Dev builds would continuously overwrite the alias currently
  promoted by Beta.
- It would make manual diagnostics ambiguous: `latest` would usually mean an
  arbitrary recent Dev commit.
- Packaged installations do not need it; they pull their exact
  `dockerImageTag`.

If a mutable convenience alias is eventually needed, use `dev-latest`, not
global `latest`, and never embed it in a package.

`RELEASING.md` currently says protected GitLab releases use the full source SHA
as the Harbor tag, while the executable CI and its regression test use the
release build ID. PORTICO-418 retains the current build-ID behavior as the smallest
compatible change and corrects the documentation. If full-SHA tags are desired
later, Dev and Beta should be changed together rather than introducing a
Dev-only convention.

The canonical release tag is intended to be immutable. A retry that encounters
an existing exact tag must reuse it only after validating source and platform
provenance, or fail rather than silently replacing it with different image
digests.

## Installed-build channel behavior

The packaged build's channel is only used to seed the installation when no
channel has been selected yet. An existing managed-root `UPDATE_CHANNEL`
remains authoritative.

| Installation scenario | Channel after startup |
| --- | --- |
| Truly clean Mac, first installation of a CI-produced Dev build | Development |
| Replace `/Applications/Portico.app` while retaining an existing Beta installation | Beta |
| Replace the app while retaining an existing Development installation | Development |
| Replace the app while no `UPDATE_CHANNEL` exists | Stable, unless the packaged build seeds Dev during initialization |

Therefore, manually replacing a Beta app with a Dev `.app` can leave the user
running a Dev binary while still subscribed to Beta updates. Startup has a
manual-DMG recovery path that reconciles the managed runtime with the new app,
but it intentionally does not override the user's channel selection.

For a working existing installation, the supported replacement flow is:

1. **Portico -> Switch Release Channel -> Development**
2. **Portico -> Reinstall Latest Build...**
3. Let the updater prepare and install the complete Dev release.

`Check for Updates` is sufficient for a normal upgrade when the Dev build is
newer. `Reinstall Latest Build` is the deterministic channel-switching
procedure because it fetches the latest package from the selected channel
without depending on whether its timestamp compares newer than the currently
installed Beta package.

## Branch protection is a release security boundary

The release workflow requires `CI_COMMIT_REF_PROTECTED == "true"`. The `dev`
branch must therefore be protected before adding it to the release rules.

Protection matters because release jobs can obtain:

- Apple signing and notarization credentials
- Cloudsmith publication credentials
- Harbor push credentials
- other protected release secrets

Without branch protection, anyone allowed to push to `dev` could modify CI or
release scripts and run that code with release credentials.

The required initial GitLab policy is:

- force pushes disabled;
- direct pushes limited to Maintainers;
- merge permission set according to the team's reviewed Dev merge policy;
- required merge-request review and green CI before merge.

Disabling force pushes is primarily about provenance and auditability: a
published source commit should not subsequently disappear from the visible
branch history. It is not required for cancellation mechanics, but it supports
the release pipeline's branch-tip and source-identity assumptions.

## Protected-Dev credential qualification

Credential access must be proven without first enabling automatic publication.
After protecting `dev`:

1. Inspect the Vault role `portico--release`. Verify its GitLab OIDC
   bound claims permit this project and `ref_protected=true`; ensure it is not
   explicitly restricted to `ref=beta`.
2. Inspect inherited GitLab variables. Confirm `HARBOR_USER` and
   `HARBOR_TOKEN` are available as protected variables and are forwarded to the
   runtime child pipeline.
3. Run a one-time manual access-check job on protected `dev` using the same
   identities and secret declarations as the release jobs. Keep publication
   disabled for this canary.
4. Check only whether secret values are present; never print them.
5. Use an authenticated Cloudsmith list/read request.
6. Use an authenticated Harbor repository read and, if push permission needs
   explicit proof, push and remove a disposable canary tag.
7. Import the Apple P12 into a temporary keychain and verify that a signing
   identity exists. Validate notarization credentials with an authenticated
   `notarytool` request or the first controlled package canary.

If the Vault role already authorizes all protected refs, no Vault repository
change is needed. If it is Beta-specific, update the role configuration in the
Vault configuration repository before enabling automatic Dev releases.

## Release broker boundary

The `portico-release-broker` is specifically the merge-request trust
boundary. Its purpose is to prevent merge-request-controlled code from
receiving release secrets.

The broker flow is:

1. The application MR pipeline creates unsigned, credential-free staged inputs.
2. The protected broker independently validates the MR project, SHA, and
   provenance.
3. It builds untrusted runtime source without Apple or Cloudsmith credentials.
4. A separate signer job does not clone or execute MR source.
5. It signs, notarizes, and publishes an isolated `mr-<IID>` Cloudsmith package
   and MR-specific Harbor tags.

The broker also runs the daily MR-retention cleanup. It is not part of Beta or
Dev publication, and PORTICO-418 does not move the Dev release pipeline into it.
Protected Dev is already trusted and publishes directly from the application
repository.

## Repository and operations ownership

Mandatory changes:

1. **`portico` repository**
   - Dev workflow/rules and metadata
   - automatic Dev publisher
   - stale-success/no-op check
   - interruptible runtime child jobs
   - resource-group configuration
   - regression tests and documentation
   - optionally, scheduled Dev/Beta retention cleanup
2. **GitLab project settings for `portico`**
   - protect `dev`;
   - disable force pushes;
   - configure push/merge permissions;
   - configure the Dev resource group as `newest_first`.

Conditional change:

3. **Vault configuration repository**
   - only if `portico--release` is currently bound specifically to Beta
     instead of all protected refs.

No change is expected in:

- `portico-release-broker`
- PORTICO-Service
- other application repositories

## Retention policy and measured footprint

Cloudsmith inventory measured on August 4, 2026 was:

| Channel | Packages | Median package | Total |
| --- | ---: | ---: | ---: |
| Beta | 26 | 682.9 MiB | 17.41 GiB |
| Dev | 157 | 725.4 MiB | 109.30 GiB |

Recent packages were approximately 741-745 MiB each. Beta is accumulating too,
but at a much lower manual cadence. Dev already had historical bursts of up to
nine packages per day; 31 Dev packages were published within one recent
seven-day interval.

Harbor adds considerably more:

- Each release has seven multi-architecture runtime images.
- One inspected release represented approximately 2.29 GiB of unique
  compressed layers.
- Adjacent builds shared relatively little; approximately 2 GiB appeared
  incremental in the sample.
- Physical Harbor accounting may differ because of registry-wide
  deduplication and garbage collection.

A reasonable gross estimate is roughly:

```text
~0.7 GiB Cloudsmith + up to ~2.0 GiB incremental Harbor
= ~2.7 GiB per published build
```

The starting retention policy is:

- **Dev:** newest 20 successful releases, plus anything younger than seven
  days, plus manually pinned incident/rollback builds.
- **Beta:** newest 20 releases, plus pinned releases.
- **MR previews:** retain the existing seven-day policy.

At the measured recent Dev cadence, the seven-day rule would retain
approximately 31 releases: roughly 22 GiB in Cloudsmith and potentially around
60 GiB of incremental Harbor data before deduplication. If that is too
expensive, use a hard latest-20 policy, approximately 14 GiB Cloudsmith plus up
to 40 GiB Harbor in the observed sample.

## Cleanup is scheduled CI/CD, not a per-release job

Dev/Beta lifecycle cleanup should be a separate daily GitLab scheduled pipeline
in the `portico` repository, not a job that runs after every Dev
publication.

It must:

1. Start in report-only/dry-run mode.
2. Identify retained and pinned Cloudsmith packages.
3. Delete expired Dev/Beta packages.
4. Delete the corresponding seven Harbor tags only when no retained Dev, Beta,
   custom, or MR package still references them.
5. Also remove the architecture/pipeline-scoped helper tags created by the
   runtime child pipeline; deleting only the canonical tag may not release the
   layers.
6. Use a publication lock or a sufficient grace period so it cannot race with
   an in-progress release.
7. Report cleanup failure separately without blocking new releases.

The existing broker cleanup is MR-specific and remains so. Dev/Beta lifecycle
cleanup belongs with the application release configuration. Retention cleanup
may be delivered after the automatic Dev publisher, but automatic Dev releases
must not run indefinitely without an agreed cleanup owner and follow-up.

## Rollout order

1. Protect `dev` and disable force pushes.
2. Verify Vault and inherited Harbor access with a non-publishing protected-Dev
   canary.
3. Create the `portico-dev-release` resource group without publishing,
   then configure and verify its process mode before enabling the automatic
   publisher:

   ```bash
   curl --fail-with-body \
     --request PUT \
     --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
     --form process_mode=newest_first \
     "$CI_API_V4_URL/projects/$CI_PROJECT_ID/resource_groups/portico-dev-release"

   curl --fail-with-body \
     --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
     "$CI_API_V4_URL/projects/$CI_PROJECT_ID/resource_groups/portico-dev-release"
   ```

   GitLab creates a new resource group as `unordered`, and its process mode is
   configured through the Resource Groups API rather than CI YAML. Create the
   group with a temporary non-publishing manual canary that uses the same key,
   or cancel the first pipeline before its publisher starts. Do not race the
   first automatic publisher while changing the mode.
4. Publish one controlled Dev release.
5. Validate a clean Dev install.
6. Validate an existing Beta installation switching to Development and using
   `Reinstall Latest Build`.
7. Enable the normal every-push behavior.
8. Add scheduled retention cleanup in dry-run mode, review its reports, and
   then enable deletion.

## Acceptance criteria

- Every protected `dev` push creates a release pipeline.
- A superseded pre-publication pipeline is cancelled.
- A stale Dev publisher exits zero without changing the Dev channel.
- The latest viable pipeline publishes a signed and notarized
  `portico_dev` package.
- A clean installation of that package selects Development.
- Replacing an existing app does not overwrite its stored channel choice.
- The package and generated runtime configuration use the exact attested
  `dockerImageTag`.
- Dev does not upload to PORTICO-Service or promote global Harbor `latest`.
- Beta's manual and fail-closed publication behavior remains unchanged.
- MR pipelines remain credential-free and the release-broker boundary remains
  unchanged.
