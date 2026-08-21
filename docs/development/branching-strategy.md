# Branching Strategy for AI Chat

## Summary

Portico should use short-lived feature branches into `dev`, temporary release-candidate branches for beta stabilization, a protected `beta` branch for the latest validated beta state, and a protected `main` branch reserved for the stable channel.

The long-lived branches are:

| Branch | Meaning | Release behavior |
| :---- | :---- | :---- |
| `dev` | Fast-moving integration branch for reviewed feature, fix, and refactor work. | CI/CD publishes dev-channel builds automatically. |
| `beta` | Latest validated beta state used by daily users. Always releasable. | Cloudsmith beta release is manually triggered from an immutable tag pointing to the validated `beta` commit. |
| `main` | Stable-channel state. Currently dormant until the stable channel is actively maintained. | Future stable releases come from this branch. |

The temporary branches are:

| Branch pattern | Purpose | Lifetime |
| :---- | :---- | :---- |
| `feature/<short-name>` | Normal feature work. | Deleted after merge to `dev`. |
| `fix/<short-name>` | Normal bug fix work. | Deleted after merge to `dev`. |
| `refactor/<short-name>` | Reviewable refactor slice. | Deleted after merge to `dev`. |
| `release/beta-YYYY-MM-DD` or `release/beta-<version>` | Frozen candidate for manual beta validation. | Deleted after promotion to `beta` and tagging. |
| `hotfix/<short-name>` | Urgent beta fix. | Merged to `beta` and back to `dev`, then deleted. |

## Branch topology

```text
feature/*, fix/*, refactor/*
        │
        ▼
dev  ─────────▶ automatic dev-channel builds
        │
        │ cut candidate when ready
        ▼
release/beta-YYYY-MM-DD ─────────▶ candidate builds installable by exact build id
        │
        │ manual validation + stabilization fixes only
        ▼
beta ─────────▶ tag validated commit, then manually trigger Cloudsmith release
        │
        │ future stable promotion
        ▼
main ─────────▶ future stable-channel releases
```

## Daily development flow

1. Create a small branch from `dev`:
   - `feature/<short-name>`
   - `fix/<short-name>`
   - `refactor/<short-name>`
2. Open a small PR into `dev`.
3. Require review and CI before merge.
4. Merge to `dev`.
5. CI/CD builds and publishes a dev-channel build.

`dev` is allowed to move quickly. It is the branch where integration problems are discovered before they reach daily beta users.

The detailed trigger, cancellation, publication, security, installation, and
retention contract for automatic Dev releases is recorded in
[PORTICO-418: Automatic Dev-channel release pipeline](dev-channel-release-pipeline.md).

## Beta release flow

Current automated coverage is not strong enough to guarantee that every merge is safe. That's why we need to do manual testing before publishing a new release. Manual testing needs a frozen candidate while `dev` continues moving. If testers are validating dev, new work keeps landing underneath them. If testers are validating beta, then we risk mixing “candidate under test” with “last known releasable beta.” Also, release-blocking fixes need a clean place to land without admitting unrelated new work.

A separate release branch prevents one feature on `dev` from blocking an otherwise ready beta release and allows for release stabilization while development continues.

1. Cut a release candidate branch from a selected `dev` commit:

   ```text
   release/beta-2026-06-29
   ```

2. CI/CD builds the release-candidate branch.
3. The candidate is not published to the dev, beta, or stable release channel.
4. Testers install the exact candidate using the existing "install specific build" path.
5. Only release-blocking stabilization fixes merge into the release branch.
6. Each push to the release branch produces a new installable candidate build.
7. When manual validation passes, merge the release branch to `beta`.
8. Before deleting the release branch, merge or cherry-pick all stabilization fixes back to `dev`, unless `dev` already contains equivalent commits.
9. Tag the validated `beta` commit and delete the release branch.
10. Manually trigger the Cloudsmith beta release using the new tag. Cloudsmith publishes the commit that exact tag points to.

## Hotfix flow

For urgent fixes to the currently shipped beta:

1. Branch from `beta`:

   ```text
   hotfix/<short-name>
   ```

2. Merge the fix to `beta` after focused validation.
3. Tag the validated `beta` commit.
4. Manually trigger the Cloudsmith beta release using the new tag.
5. Merge the same fix back to `dev`.

Hotfixes should be narrow. If the fix is not urgent for beta users, it should go through `dev` and the next release-candidate branch instead.
