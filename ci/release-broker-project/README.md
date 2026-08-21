# Portico release broker

This directory is the canonical source for the protected GitLab project
`portico/portico-release-broker`. Copy its contents to that
project, protect `main`, and disallow direct pushes before enabling pipelines.

The broker accepts downstream pipelines only for same-project merge requests
from `portico/portico`. It builds untrusted source without Apple
or Cloudsmith credentials, then signs staged app bundles in a separate job that
does not clone or execute merge-request source.

Required setup:

- allow the application project to trigger broker `main` pipelines;
- allow broker job tokens to read the application repository and merge request
  API with `READ_REPOSITORIES` and `READ_MERGE_REQUESTS`;
- link `shared-pure`, native `amd64`, native `arm64`, and `map-macos-vm` runners;
- use the SUP-managed root Vault role `portico--release-broker`, bound
  to this project's protected `main` by `groups/portico.yaml` in
  `consul-vault/vault-namespaces`; do not set `VAULT_NAMESPACE`;
- store the Apple P12/password, Apple ID/app password, Apple Team ID,
  Cloudsmith API key and entitlement token as properties in Secret Unit
  `gitlab-ci/release-secrets`;
- configure `HARBOR_USER` and `HARBOR_TOKEN` as protected, masked, raw broker
  project variables. The pinned container-image trigger must forward these to
  its child pipeline and GitLab trigger jobs cannot resolve Vault secrets;
- configure the application's numeric project ID as the protected, raw,
  non-secret `portico_SOURCE_PROJECT_ID` broker variable so scheduled cleanup can
  resolve merge requests when there is no upstream trigger;
- configure a daily scheduled pipeline on `main` with `portico_CLEANUP_ONLY=true`.

`portico_RELEASE_TOOLING_REF` defaults to protected application branch
`beta` and must contain the release payload validator and MR staging
contract used here.
