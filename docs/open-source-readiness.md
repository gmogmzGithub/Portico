# Open-source readiness

This repository is being converted into a provider-neutral integration
workbench. The goal is to keep the useful product behavior while making model
access, marketplaces, and release infrastructure replaceable.

## Working product name

**Portico** is the current working name.

The word describes an entryway or covered connector: a useful metaphor for a
desktop and container runtime that gives agents a controlled way into external
models, tools, and services. It is intentionally separate from the repository's
current directory name. Name availability, trademark questions, and the final
GitHub slug still need an explicit check before publication.

Other names considered during the first pass were **Vinculum** (a bond or
connecting link) and **Tessera** (a small piece that contributes to a larger
whole). Both communicate composition, but they are already used by multiple
AI and MCP projects, so Portico is the clearer working direction.

## Public boundary

The public project should contain:

- the chat and desktop surfaces;
- the model gateway interfaces and provider examples;
- the MCP control plane and generic lifecycle behavior;
- skills, workspaces, artifacts, approvals, and test harnesses;
- public documentation and reproducible local development instructions.

It should not contain organization-owned defaults, private service URLs,
internal package registries, private marketplace manifests, release credentials,
or deployment-specific identity headers. The default advanced MCP manifest is
empty, and the checked-in marketplace seed is limited to a public example
source.

## Readiness classification

### Remaining extraction work

- The final name, GitHub slug, trademark review, license, and contributor
  governance still need an explicit decision.
- Release, signing, update, and deployment scripts are still richer than the
  first public distribution needs and should be split from the local developer
  path.
- Some optional MCP configurations, operational documents, fixtures, and
  copied assets still need an ownership and redistribution review.
- The bundled font and image assets were renamed for the working product name,
  but they must not be published until their redistribution rights are
  confirmed or they are replaced with public assets.
- A clean-checkout build should be repeated after dependency metadata is
  regenerated against public registries.

### Keep, but make provider-neutral

- MCP transport, OAuth, health, lifecycle, and consent behavior.
- Tool confirmation and destructive-action policy.
- Agent skills and skill discovery contracts.
- Workspaces, artifact snapshots, subagents, scheduling, and chat state.
- Behavioral tests and security checks, after removing private fixtures and
  source-text assertions.

### Remove from the first public distribution

- Private release-broker, signing, and internal-registry pipelines.
- Private operational incident reports and internal planning documents.
- Organization-only marketplace entries and credentials.
- Generated local state, debug captures, dependency trees, and build outputs.

## Non-technical release blockers

Before publishing a copied codebase, confirm that the publisher has the right
to redistribute the source, bundled patches, assets, and dependencies. Also
choose and add a license, contributor guide, security policy, and third-party
notice process. This repository does not make those legal or governance
decisions automatically.

## Suggested extraction order

1. Keep the generic local path working with public model APIs and public MCP
   examples.
2. Move optional integrations behind explicit adapters or local-only
   configuration.
3. Decide the final product identity and replace the working name if needed.
4. Remove private documents and generated artifacts, add the public governance
   files, and run the complete test/security gates from a clean checkout.
