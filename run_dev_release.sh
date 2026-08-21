#!/usr/bin/env bash

set -euo pipefail
umask 077

DEFAULT_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -n "${portico_RELEASE_EXTRA_PATH:-}" ]; then
    export PATH="${portico_RELEASE_EXTRA_PATH}:${DEFAULT_PATH}:${PATH:-}"
else
    export PATH="${DEFAULT_PATH}:${PATH:-}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${portico_RELEASE_REPO_ROOT:-$SCRIPT_DIR}"
RELEASE_CHANNEL_SH="$REPO_ROOT/src/scripts/release-channel.sh"
HARBOR_REGISTRY="${HARBOR_REGISTRY:-harbor.example.invalid}"
HARBOR_USER="${HARBOR_USER:-${USER:-}}"
PACKAGED_ZIP=""
RELEASE_NODE_VERSION_REQUIRED="22.12.0"
RELEASE_CHANNEL="dev"
CHANNEL_PACKAGE_NAME="portico_dev"
SOURCE_REVISION=""
RELEASE_TIMESTAMP=""
DOCKER_IMAGE_TAG=""
HOST_MCP_BINARIES_DIR=""
RUNTIME_IMAGE_ATTESTATION=""
PREVIEW_OUTPUT_DIR=""
MR_STAGE_OUTPUT_DIR=""
MR_PROJECT_ID=""
MR_PROJECT_PATH=""
MR_IID=""
MR_TARGET_BRANCH=""
RELEASE_BRANCH=""
REQUIRE_BRANCH_TIP=false
REPUBLISH=false
WAIT_FOR_SYNC=true
MARK_UPDATE_READY=true

if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    printf 'ERROR: missing release channel helper: %s\n' "$RELEASE_CHANNEL_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

usage() {
    cat <<'EOF'
Usage: ./run_dev_release.sh <command> [argument] [options]

Run the Portico dev release workflow from a normal shell.

Commands:
  preflight             Validate credentials, tools, Docker, and pushed git state
  package [build-id]    Authenticate to Harbor and create the exact payload
  publish <zip-path>    Publish an exact payload to Cloudsmith
  all [build-id]        Package and publish the same exact payload
  preview <arch>        Build an unsigned arm64 or x64 MR preview
  stage-mr [build-id]   Stage unsigned MR release inputs without credentials

Release channel:
  --channel <name>      stable, beta, dev, or a custom slug (default: dev)

CI-only additive options:
  --source-revision <sha>        Require the checkout to match this full SHA
  --docker-image-tag <tag>       Runtime Docker image tag to embed in metadata
  --release-timestamp <utc>      Reuse one fixed UTC timestamp across CI jobs
  --host-mcp-binaries-dir <dir>  Reuse a complete revision-marked host tree
  --image-attestation <path>     Reuse validated immutable runtime images
  --preview-output-dir <dir>     Write the unsigned app ZIP and DMG here
  --stage-output-dir <dir>       Write credential-free MR release inputs here
  --mr-project-id <id>           GitLab source project numeric id
  --mr-project-path <path>       GitLab source project namespace/path
  --mr-iid <iid>                 GitLab project-scoped merge request number
  --mr-target-branch <name>      Merge request target branch
  --branch <name>                Protected release branch for tip validation
  --require-branch-tip           Refuse stale publish/promote work
  --republish                    Idempotently replace the same Cloudsmith version
  --wait-for-sync                Keep publication open until Cloudsmith synchronizes
  --mark-update-ready            Verify the published ZIP and mark it eligible for updates

Required environment variables for package/all:
  HARBOR_TOKEN
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
  CLOUDSMITH_API_KEY

Optional environment variables:
  HARBOR_REGISTRY       Defaults to harbor.example.invalid
  HARBOR_USER           Defaults to USER

When present, the runner loads credentials from the repository-root .env file,
which must have mode 0600. Otherwise, export credentials in the caller shell.
The runner disables shell tracing before loading credentials, never prints their
values, and passes the Harbor token through stdin.

Electron packaging requires Node.js >= 22.12.0 with npm. Preflight automatically
selects a compatible runtime from configured, Homebrew, NVM, or managed paths.

The existing local preflight/package/publish/all defaults are unchanged. CI-only
behavior activates only when the corresponding options above are supplied.
The stage-mr command never loads the repository .env and refuses release secrets.
EOF
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

release_env_mode() {
    local env_file="$1"
    local mode

    if mode="$(stat -f '%Lp' "$env_file" 2>/dev/null)"; then
        :
    elif mode="$(stat -c '%a' "$env_file" 2>/dev/null)"; then
        :
    else
        die "unable to inspect release environment permissions: $env_file"
    fi

    printf '%s\n' "$mode"
}

load_release_env() {
    local env_file="$REPO_ROOT/.env"
    local mode
    local allexport_was_enabled=0
    local filtered_env=""

    # Release commands consume credentials even when no dotenv exists, so
    # suppress tracing before either the file-backed or inherited path.
    set +x
    [ -e "$env_file" ] || return 0
    [ -f "$env_file" ] || die "release environment is not a regular file: $env_file"

    mode="$(release_env_mode "$env_file")"
    case "$mode" in
        600|0600) ;;
        *) die "release environment must have mode 0600 (found $mode): $env_file" ;;
    esac

    case "$-" in
        *a*) allexport_was_enabled=1 ;;
    esac

    # Never allow xtrace to expose credentials from the operator-provided file
    # or from later release commands that consume those values. Identity is a
    # Compose/dotenv runtime mirror, not release-operator input; exclude those
    # two canonical lines before evaluating the remaining shell assignments.
    filtered_env="$(mktemp "${TMPDIR:-/tmp}/portico-release-env.XXXXXX")" \
        || die "unable to create temporary release environment file"
    chmod 600 "$filtered_env" 2>/dev/null || true
    if ! awk '
        /^[[:space:]]*(export[[:space:]]+)?PORTICO_USER_(ID|NAME)[[:space:]]*=/ { next }
        { print }
    ' "$env_file" >"$filtered_env"; then
        rm -f "$filtered_env"
        die "unable to filter release environment: $env_file"
    fi

    set -a
    # shellcheck disable=SC1090
    if ! . "$filtered_env"; then
        if [ "$allexport_was_enabled" -eq 0 ]; then
            set +a
        fi
        rm -f "$filtered_env"
        die "release environment contains invalid shell assignments: $env_file"
    fi
    if [ "$allexport_was_enabled" -eq 0 ]; then
        set +a
    fi
    rm -f "$filtered_env"

    printf 'Loaded release environment from protected repository .env.\n'
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

normalize_semver() {
    local raw="$1"
    local version="${raw#v}"
    local major minor patch

    version="${version%%-*}"
    version="${version%%+*}"
    if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
        return 1
    fi

    IFS='.' read -r major minor patch <<< "$version"
    minor="${minor:-0}"
    patch="${patch:-0}"
    printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

semver_gte() {
    local left right
    local l_major l_minor l_patch r_major r_minor r_patch

    left="$(normalize_semver "$1")" || return 1
    right="$(normalize_semver "$2")" || return 1
    IFS='.' read -r l_major l_minor l_patch <<< "$left"
    IFS='.' read -r r_major r_minor r_patch <<< "$right"

    if (( l_major > r_major )); then return 0; fi
    if (( l_major < r_major )); then return 1; fi
    if (( l_minor > r_minor )); then return 0; fi
    if (( l_minor < r_minor )); then return 1; fi
    (( l_patch >= r_patch ))
}

resolve_release_node_bin_dir() {
    local path_candidates=""
    local candidate_dir install_dir install_root
    local node_path npm_path node_version_raw node_version
    local entries install_root_entries
    local seen=":"

    if [ -n "${portico_RELEASE_EXTRA_PATH:-}" ]; then
        path_candidates="$portico_RELEASE_EXTRA_PATH"
    fi
    if [ -n "${PATH:-}" ]; then
        path_candidates="${path_candidates:+${path_candidates}:}${PATH}"
    fi

    for candidate_dir in \
        /opt/homebrew/opt/node@22/bin \
        /usr/local/opt/node@22/bin \
        /opt/homebrew/opt/node/bin \
        /usr/local/opt/node/bin; do
        [ -d "$candidate_dir" ] || continue
        path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
    done

    for install_dir in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin; do
        [ -d "$install_dir" ] || continue
        path_candidates="${path_candidates:+${path_candidates}:}${install_dir}"
    done

    IFS=':' read -r -a install_root_entries \
        <<< "${portico_RELEASE_NODE_INSTALL_ROOTS:-$HOME/.local/lib/nodejs:/usr/local/lib/nodejs}"
    for install_root in "${install_root_entries[@]}"; do
        [ -n "$install_root" ] || continue
        for install_dir in "$install_root"/node-*/bin; do
            [ -d "$install_dir" ] || continue
            path_candidates="${path_candidates:+${path_candidates}:}${install_dir}"
        done
    done

    IFS=':' read -r -a entries <<< "$path_candidates"
    for candidate_dir in "${entries[@]}"; do
        [ -n "$candidate_dir" ] || continue
        case "$seen" in
            *":${candidate_dir}:"*) continue ;;
            *) seen="${seen}${candidate_dir}:" ;;
        esac

        node_path="$candidate_dir/node"
        npm_path="$candidate_dir/npm"
        [ -x "$node_path" ] || continue
        [ -x "$npm_path" ] || continue

        node_version_raw="$("$node_path" --version 2>/dev/null || true)"
        node_version="$(normalize_semver "$node_version_raw" 2>/dev/null || true)"
        [ -n "$node_version" ] || continue
        semver_gte "$node_version" "$RELEASE_NODE_VERSION_REQUIRED" || continue
        "$npm_path" --version >/dev/null 2>&1 || continue

        printf '%s\n' "$candidate_dir"
        return 0
    done

    return 1
}

select_release_node_runtime() {
    local selected_dir node_path node_version current_node current_version

    selected_dir="$(resolve_release_node_bin_dir || true)"
    if [ -z "$selected_dir" ]; then
        current_node="$(command -v node 2>/dev/null || true)"
        current_version=""
        if [ -n "$current_node" ]; then
            current_version="$("$current_node" --version 2>/dev/null || true)"
        fi
        die "Node.js >= v${RELEASE_NODE_VERSION_REQUIRED} with npm is required for Electron release packaging; detected ${current_version:-no compatible Node.js} at ${current_node:-no path}"
    fi

    export PATH="${selected_dir}:${PATH:-}"
    hash -r
    node_path="$(command -v node)"
    node_version="$(node --version)"
    printf 'Using Node.js %s from %s for release packaging.\n' "$node_version" "$node_path"
}

require_env() {
    local name="$1"
    [ -n "${!name:-}" ] || die "missing required environment variable: $name"
}

require_repo() {
    [ -d "$REPO_ROOT/.git" ] || die "not a git checkout: $REPO_ROOT"
    [ -x "$REPO_ROOT/package_for_release.sh" ] || die "missing package_for_release.sh in $REPO_ROOT"
    [ -x "$REPO_ROOT/release_build.sh" ] || die "missing release_build.sh in $REPO_ROOT"
}

require_package_environment() {
    require_env HARBOR_TOKEN
    require_env HARBOR_USER
    require_env APPLE_ID
    require_env APPLE_APP_SPECIFIC_PASSWORD
    require_env APPLE_TEAM_ID
    require_env CLOUDSMITH_API_KEY
    require_env CLOUDSMITH_ENTITLEMENT_TOKEN
}

require_publish_environment() {
    require_env CLOUDSMITH_API_KEY
    if [ "$MARK_UPDATE_READY" = true ]; then
        require_env CLOUDSMITH_ENTITLEMENT_TOKEN
    fi
}

require_attested_package_environment() {
    require_env APPLE_ID
    require_env APPLE_APP_SPECIFIC_PASSWORD
    require_env APPLE_TEAM_ID
    require_env CLOUDSMITH_API_KEY
    require_env CLOUDSMITH_ENTITLEMENT_TOKEN
}

validate_source_revision_value() {
    [ -z "$SOURCE_REVISION" ] && return 0
    [[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] \
        || die "--source-revision must be a full lowercase git SHA"
}

validate_release_timestamp_value() {
    [ -z "$RELEASE_TIMESTAMP" ] && return 0
    [[ "$RELEASE_TIMESTAMP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]] \
        || die "--release-timestamp must be a UTC RFC3339 timestamp ending in Z"
}

validate_docker_image_tag_value() {
    [ -z "$DOCKER_IMAGE_TAG" ] && return 0
    [[ "$DOCKER_IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
        || die "--docker-image-tag is invalid"
}

validate_ci_source() {
    local head tracked_changes

    validate_source_revision_value
    [ -n "$SOURCE_REVISION" ] || {
        validate_pushed_source
        return 0
    }

    cd "$REPO_ROOT"
    tracked_changes="$(git status --porcelain --untracked-files=no)"
    [ -z "$tracked_changes" ] || die "tracked worktree changes exist; commit them before packaging"
    git --no-pager diff --check
    head="$(git rev-parse HEAD | tr '[:upper:]' '[:lower:]')"
    [ "$head" = "$SOURCE_REVISION" ] \
        || die "HEAD does not match --source-revision"
}

validate_attested_ci_inputs() {
    local validator="$REPO_ROOT/src/scripts/validate-runtime-image-attestation.js"

    [ -n "$SOURCE_REVISION" ] \
        || die "--image-attestation requires --source-revision"
    [ -n "$HOST_MCP_BINARIES_DIR" ] \
        || die "--image-attestation requires --host-mcp-binaries-dir"
    [ -d "$HOST_MCP_BINARIES_DIR" ] \
        || die "host-mcp-binaries directory does not exist: $HOST_MCP_BINARIES_DIR"
    [ -f "$RUNTIME_IMAGE_ATTESTATION" ] \
        || die "runtime image attestation does not exist: $RUNTIME_IMAGE_ATTESTATION"
    [ -f "$validator" ] || die "runtime image attestation validator is missing: $validator"
    node "$validator" \
        --attestation "$RUNTIME_IMAGE_ATTESTATION" \
        --expected-source-revision "$SOURCE_REVISION" \
        --expected-tag "$DOCKER_IMAGE_TAG" \
        --quiet \
        || die "runtime image attestation validation failed"
}

validate_preview_inputs() {
    local arch="$1"

    case "$arch" in
        arm64|x64) ;;
        *) die "preview requires arm64 or x64" ;;
    esac
    [ -n "$SOURCE_REVISION" ] || die "preview requires --source-revision"
    [ -n "$RELEASE_TIMESTAMP" ] || die "preview requires --release-timestamp"
    [ -n "$HOST_MCP_BINARIES_DIR" ] \
        || die "preview requires --host-mcp-binaries-dir"
    [ -d "$HOST_MCP_BINARIES_DIR" ] \
        || die "host-mcp-binaries directory does not exist: $HOST_MCP_BINARIES_DIR"
    [ -n "$PREVIEW_OUTPUT_DIR" ] || die "preview requires --preview-output-dir"
}

require_no_release_credentials() {
    local name
    for name in \
        HARBOR_TOKEN \
        APPLE_CODESIGN_P12_BASE64 \
        APPLE_CODESIGN_P12_PASSWORD \
        APPLE_ID \
        APPLE_APP_SPECIFIC_PASSWORD \
        CLOUDSMITH_API_KEY \
        CLOUDSMITH_ENTITLEMENT_TOKEN
    do
        [ -z "${!name:-}" ] \
            || die "stage-mr refuses credential-bearing environment variable: $name"
    done
}

validate_mr_stage_inputs() {
    [ -n "$SOURCE_REVISION" ] || die "stage-mr requires --source-revision"
    [ -n "$RELEASE_TIMESTAMP" ] || die "stage-mr requires --release-timestamp"
    [ -n "$HOST_MCP_BINARIES_DIR" ] \
        || die "stage-mr requires --host-mcp-binaries-dir"
    [ -d "$HOST_MCP_BINARIES_DIR" ] \
        || die "host-mcp-binaries directory does not exist: $HOST_MCP_BINARIES_DIR"
    [ -n "$MR_STAGE_OUTPUT_DIR" ] || die "stage-mr requires --stage-output-dir"
    [[ "$MR_PROJECT_ID" =~ ^[1-9][0-9]*$ ]] \
        || die "stage-mr requires a positive --mr-project-id"
    [[ "$MR_PROJECT_PATH" =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$ ]] \
        || die "stage-mr requires a valid --mr-project-path"
    [[ "$MR_IID" =~ ^[1-9][0-9]*$ ]] \
        || die "stage-mr requires a positive --mr-iid"
    [ -n "$MR_TARGET_BRANCH" ] || die "stage-mr requires --mr-target-branch"
    git check-ref-format --branch "$MR_TARGET_BRANCH" >/dev/null 2>&1 \
        || die "stage-mr received an invalid --mr-target-branch"
    [ "$RELEASE_CHANNEL" = "mr-${MR_IID}" ] \
        || die "stage-mr channel must be mr-${MR_IID}"
}

validate_pushed_source() {
    local head upstream tracked_changes

    cd "$REPO_ROOT"
    tracked_changes="$(git status --porcelain --untracked-files=no)"
    [ -z "$tracked_changes" ] || die "tracked worktree changes exist; commit them before packaging"
    git --no-pager diff --check

    head="$(git rev-parse HEAD)"
    upstream="$(git rev-parse '@{upstream}' 2>/dev/null)" \
        || die "current branch has no upstream; push it before packaging"
    [ "$head" = "$upstream" ] \
        || die "HEAD does not match its upstream; push the exact commit before packaging"
}

preflight_package() {
    require_repo
    require_command git
    require_command xcrun
    select_release_node_runtime
    validate_release_timestamp_value
    validate_docker_image_tag_value

    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        require_attested_package_environment
        validate_ci_source
        validate_attested_ci_inputs
        return 0
    fi

    require_command docker
    require_package_environment
    validate_pushed_source
    docker info >/dev/null 2>&1 || die "Docker is not available"
}

default_build_id() {
    local short_sha
    short_sha="$(git -C "$REPO_ROOT" rev-parse --short=8 HEAD)"
    printf '%s-%s\n' "$(date +%m%d%Y)" "$short_sha"
}

validate_build_id() {
    local build_id="$1"
    case "$build_id" in
        ""|*[!A-Za-z0-9._-]*) die "invalid build id: $build_id" ;;
    esac
}

package_release() {
    local build_id="${1:-}"
    local head zip_path
    local package_args=()

    if [ -z "$build_id" ]; then
        build_id="$(default_build_id)"
    fi
    validate_build_id "$build_id"
    if [ -z "$DOCKER_IMAGE_TAG" ]; then
        DOCKER_IMAGE_TAG="$build_id"
    fi
    validate_docker_image_tag_value

    preflight_package

    if [ -z "$RUNTIME_IMAGE_ATTESTATION" ]; then
        printf '%s' "$HARBOR_TOKEN" \
            | docker login --username "$HARBOR_USER" --password-stdin "$HARBOR_REGISTRY" >/dev/null
    fi

    head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    zip_path="$REPO_ROOT/release/${CHANNEL_PACKAGE_NAME}-${build_id}.zip"

    package_args=(
        "$build_id"
        --channel "$RELEASE_CHANNEL"
        --full-sha "$head"
        --docker-image-tag "$DOCKER_IMAGE_TAG"
        --output-zip "$zip_path"
        --yes
    )
    if [ -n "$RELEASE_TIMESTAMP" ]; then
        package_args+=(--release-timestamp "$RELEASE_TIMESTAMP")
    fi
    if [ -n "$HOST_MCP_BINARIES_DIR" ]; then
        package_args+=(--host-mcp-binaries-dir "$HOST_MCP_BINARIES_DIR")
    fi
    if [ -n "$SOURCE_REVISION" ] && [ -n "$HOST_MCP_BINARIES_DIR" ]; then
        package_args+=(--host-mcp-source-revision "$SOURCE_REVISION")
    fi
    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        package_args+=(--image-attestation "$RUNTIME_IMAGE_ATTESTATION")
    fi

    "$REPO_ROOT/package_for_release.sh" "${package_args[@]}"

    [ -f "$zip_path" ] || die "packaging completed without the expected payload: $zip_path"
    PACKAGED_ZIP="$zip_path"
    printf 'Release payload: %s\n' "$PACKAGED_ZIP"
}

absolute_existing_file() {
    local path="$1"
    local directory base

    [ -f "$path" ] || die "release payload does not exist: $path"
    directory="$(cd "$(dirname "$path")" && pwd -P)"
    base="$(basename "$path")"
    printf '%s/%s\n' "$directory" "$base"
}

publish_release() {
    local requested_zip="$1"
    local zip_path base
    local publish_args=()

    require_repo
    require_publish_environment
    if [ "$REQUIRE_BRANCH_TIP" = true ]; then
        [ -n "$RELEASE_BRANCH" ] || die "--require-branch-tip requires --branch"
        [ -n "$SOURCE_REVISION" ] || die "--require-branch-tip requires --source-revision"
        validate_source_revision_value
        bash "$REPO_ROOT/src/scripts/ci/assert-release-branch-tip.sh" \
            --branch "$RELEASE_BRANCH" \
            --source-revision "$SOURCE_REVISION"
    fi
    zip_path="$(absolute_existing_file "$requested_zip")"
    base="$(basename "$zip_path")"
    case "$base" in
        "${CHANNEL_PACKAGE_NAME}"-*.zip) ;;
        *) die "payload does not match release channel ${RELEASE_CHANNEL}: $zip_path" ;;
    esac

    publish_args=("$zip_path" --channel "$RELEASE_CHANNEL" --yes)
    if [ "$REPUBLISH" = true ]; then
        publish_args+=(--republish)
    fi
    if [ "$WAIT_FOR_SYNC" = true ]; then
        publish_args+=(--wait-for-sync)
    fi
    if [ "$MARK_UPDATE_READY" = true ]; then
        publish_args+=(--mark-update-ready)
    fi
    "$REPO_ROOT/release_build.sh" "${publish_args[@]}"
}

preview_build_id() {
    local year month day

    validate_release_timestamp_value
    validate_source_revision_value
    year="${RELEASE_TIMESTAMP:0:4}"
    month="${RELEASE_TIMESTAMP:5:2}"
    day="${RELEASE_TIMESTAMP:8:2}"
    printf '%s%s%s-%s\n' "$month" "$day" "$year" "${SOURCE_REVISION:0:8}"
}

preview_release() {
    local arch="$1"
    local build_id=""

    require_repo
    require_command git
    select_release_node_runtime
    validate_preview_inputs "$arch"
    validate_ci_source
    build_id="$(preview_build_id)"

    "$REPO_ROOT/package_for_release.sh" "$build_id" \
        --channel "$RELEASE_CHANNEL" \
        --full-sha "$SOURCE_REVISION" \
        --release-timestamp "$RELEASE_TIMESTAMP" \
        --host-mcp-binaries-dir "$HOST_MCP_BINARIES_DIR" \
        --host-mcp-source-revision "$SOURCE_REVISION" \
        --unsigned-preview "$arch" \
        --preview-output-dir "$PREVIEW_OUTPUT_DIR" \
        --yes
}

stage_mr_release() {
    local build_id="${1:-}"
    local image_tag=""

    require_no_release_credentials
    require_repo
    require_command git
    select_release_node_runtime
    validate_mr_stage_inputs
    validate_ci_source
    if [ -z "$build_id" ]; then
        build_id="$(preview_build_id)"
    fi
    validate_build_id "$build_id"
    image_tag="mr-${MR_IID}-${SOURCE_REVISION}"

    "$REPO_ROOT/package_for_release.sh" "$build_id" \
        --channel "$RELEASE_CHANNEL" \
        --full-sha "$SOURCE_REVISION" \
        --docker-image-tag "$image_tag" \
        --release-timestamp "$RELEASE_TIMESTAMP" \
        --host-mcp-binaries-dir "$HOST_MCP_BINARIES_DIR" \
        --host-mcp-source-revision "$SOURCE_REVISION" \
        --unsigned-mr-stage "$MR_STAGE_OUTPUT_DIR" \
        --mr-project-id "$MR_PROJECT_ID" \
        --mr-project-path "$MR_PROJECT_PATH" \
        --mr-iid "$MR_IID" \
        --mr-target-branch "$MR_TARGET_BRANCH" \
        --yes
}

parse_command_arguments() {
    local positional=()

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --channel)
                [ "$#" -ge 2 ] || die "--channel requires a value"
                RELEASE_CHANNEL="$(normalize_release_channel_name "$2")"
                shift 2
                ;;
            --source-revision)
                [ "$#" -ge 2 ] || die "--source-revision requires a value"
                SOURCE_REVISION="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
                shift 2
                ;;
            --docker-image-tag)
                [ "$#" -ge 2 ] || die "--docker-image-tag requires a value"
                DOCKER_IMAGE_TAG="$2"
                shift 2
                ;;
            --release-timestamp)
                [ "$#" -ge 2 ] || die "--release-timestamp requires a value"
                RELEASE_TIMESTAMP="$2"
                shift 2
                ;;
            --host-mcp-binaries-dir)
                [ "$#" -ge 2 ] || die "--host-mcp-binaries-dir requires a value"
                HOST_MCP_BINARIES_DIR="$2"
                shift 2
                ;;
            --image-attestation)
                [ "$#" -ge 2 ] || die "--image-attestation requires a value"
                RUNTIME_IMAGE_ATTESTATION="$2"
                shift 2
                ;;
            --preview-output-dir)
                [ "$#" -ge 2 ] || die "--preview-output-dir requires a value"
                PREVIEW_OUTPUT_DIR="$2"
                shift 2
                ;;
            --stage-output-dir)
                [ "$#" -ge 2 ] || die "--stage-output-dir requires a value"
                MR_STAGE_OUTPUT_DIR="$2"
                shift 2
                ;;
            --mr-project-id)
                [ "$#" -ge 2 ] || die "--mr-project-id requires a value"
                MR_PROJECT_ID="$2"
                shift 2
                ;;
            --mr-project-path)
                [ "$#" -ge 2 ] || die "--mr-project-path requires a value"
                MR_PROJECT_PATH="$2"
                shift 2
                ;;
            --mr-iid)
                [ "$#" -ge 2 ] || die "--mr-iid requires a value"
                MR_IID="$2"
                shift 2
                ;;
            --mr-target-branch)
                [ "$#" -ge 2 ] || die "--mr-target-branch requires a value"
                MR_TARGET_BRANCH="$2"
                shift 2
                ;;
            --branch)
                [ "$#" -ge 2 ] || die "--branch requires a value"
                RELEASE_BRANCH="$2"
                shift 2
                ;;
            --require-branch-tip)
                REQUIRE_BRANCH_TIP=true
                shift
                ;;
            --republish)
                REPUBLISH=true
                shift
                ;;
            --wait-for-sync)
                WAIT_FOR_SYNC=true
                shift
                ;;
            --mark-update-ready)
                MARK_UPDATE_READY=true
                shift
                ;;
            --)
                shift
                while [ "$#" -gt 0 ]; do
                    positional+=("$1")
                    shift
                done
                ;;
            -*) die "unknown option: $1" ;;
            *)
                positional+=("$1")
                shift
                ;;
        esac
    done

    [ "${#positional[@]}" -le 1 ] || die "expected at most one command argument"
    CHANNEL_PACKAGE_NAME="$(release_channel_to_package_name "$RELEASE_CHANNEL")" \
        || die "invalid release channel: $RELEASE_CHANNEL"
    COMMAND_ARGUMENT="${positional[0]:-}"
}

main() {
    local command="${1:-}"
    local COMMAND_ARGUMENT=""

    if [ -n "$command" ]; then
        shift
    fi

    case "$command" in
        preflight|package|publish|all)
            load_release_env
            parse_command_arguments "$@"
            ;;
        preview|stage-mr)
            parse_command_arguments "$@"
            ;;
    esac

    case "$command" in
        -h|--help|help)
            usage
            ;;
        preflight)
            [ -z "$COMMAND_ARGUMENT" ] || die "preflight does not accept a positional argument"
            preflight_package
            printf 'Release preflight passed for channel %s.\n' "$RELEASE_CHANNEL"
            ;;
        package)
            package_release "$COMMAND_ARGUMENT"
            ;;
        publish)
            [ -n "$COMMAND_ARGUMENT" ] || die "publish requires an exact payload ZIP path"
            publish_release "$COMMAND_ARGUMENT"
            ;;
        all)
            package_release "$COMMAND_ARGUMENT"
            publish_release "$PACKAGED_ZIP"
            ;;
        preview)
            [ -n "$COMMAND_ARGUMENT" ] || die "preview requires arm64 or x64"
            preview_release "$COMMAND_ARGUMENT"
            ;;
        stage-mr)
            stage_mr_release "$COMMAND_ARGUMENT"
            ;;
        "")
            usage >&2
            exit 2
            ;;
        *)
            die "unknown command: $command"
            ;;
    esac
}

main "$@"
