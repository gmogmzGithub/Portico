#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/src/scripts/release-channel.sh"

if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    printf 'Error: Missing release channel helper: %s\n' "$RELEASE_CHANNEL_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

CHANNEL="beta"
BUILD_ID=""
OUTPUT_ZIP=""
REPUBLISH=false
DRY_RUN=false
FORWARD_PACKAGE_ARGS=()

show_usage() {
    cat <<'EOF'
Usage: ./release_beta_build.sh <build-id> [options]

Compatibility wrapper for the signed macOS payload release flow.
This now packages the current workspace with package_for_release.sh and then
uploads the resulting payload via release_build.sh.

Options:
  --channel <name>               Release channel: stable, beta, dev, or a custom slug (default: beta)
  --beta                         Shortcut for --channel beta
  --stable                       Shortcut for --channel stable
  --dev                          Shortcut for --channel dev
  --replace                      Replace an existing Cloudsmith raw package
  --republish                    Alias for --replace
  --dry-run                      Create the payload and print upload details only
  --output-zip <path>            Output payload zip path
  --managed-root-source <dir>    Forwarded to package_for_release.sh
  --artifact-search-root <dir>   Forwarded to package_for_release.sh
  --host-mcp-binaries-dir <dir>  Forwarded to package_for_release.sh
  --full-sha <sha>               Forwarded to package_for_release.sh
  --docker-image-tag <tag>       Forwarded to package_for_release.sh
  --app-arm64 <path>             Forwarded to package_for_release.sh
  --app-x64 <path>               Forwarded to package_for_release.sh
  --dmg-arm64 <path>             Forwarded to package_for_release.sh
  --dmg-x64 <path>               Forwarded to package_for_release.sh
  --help, -h                     Show this help text

Deprecated:
  --remote-branch is no longer supported. Release from the checked-out workspace instead.
EOF
}

channel_to_package_name() {
    release_channel_to_package_name "$1"
}

parse_args() {
    local positional=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --channel)
                [ $# -ge 2 ] || { show_usage >&2; exit 1; }
                CHANNEL="$(normalize_release_channel_name "$2")"
                shift 2
                ;;
            --beta|--stable|--dev)
                CHANNEL="${1#--}"
                shift
                ;;
            --replace|--republish)
                REPUBLISH=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --output-zip|--managed-root-source|--artifact-search-root|--host-mcp-binaries-dir|--full-sha|--docker-image-tag|--app-arm64|--app-x64|--dmg-arm64|--dmg-x64)
                [ $# -ge 2 ] || { show_usage >&2; exit 1; }
                FORWARD_PACKAGE_ARGS+=("$1" "$2")
                if [ "$1" = "--output-zip" ]; then
                    OUTPUT_ZIP="$2"
                fi
                shift 2
                ;;
            --remote-branch)
                echo "Error: --remote-branch is no longer supported; switch your workspace to the desired branch first." >&2
                exit 1
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            --)
                shift
                while [[ $# -gt 0 ]]; do
                    positional+=("$1")
                    shift
                done
                ;;
            -*)
                echo "Error: Unknown argument: $1" >&2
                show_usage >&2
                exit 1
                ;;
            *)
                positional+=("$1")
                shift
                ;;
        esac
    done

    if [ "${#positional[@]}" -ne 1 ]; then
        show_usage >&2
        echo "Error: Exactly one build id is required." >&2
        exit 1
    fi

    BUILD_ID="$(printf '%s' "${positional[0]}" | tr '[:upper:]' '[:lower:]')"
}

main() {
    parse_args "$@"

    local channel_package_name
    if ! channel_package_name="$(channel_to_package_name "$CHANNEL")"; then
        echo "Error: Invalid release channel: $CHANNEL" >&2
        exit 1
    fi

    if [ -z "$OUTPUT_ZIP" ]; then
        OUTPUT_ZIP="$SCRIPT_DIR/release/${channel_package_name}-${BUILD_ID}.zip"
    fi

    bash "$SCRIPT_DIR/package_for_release.sh" "$BUILD_ID" --channel "$CHANNEL" "${FORWARD_PACKAGE_ARGS[@]}"

    local upload_args=("$OUTPUT_ZIP" --channel "$CHANNEL")
    if [ "$REPUBLISH" = true ]; then
        upload_args+=(--replace)
    fi
    if [ "$DRY_RUN" = true ]; then
        upload_args+=(--dry-run)
    fi

    bash "$SCRIPT_DIR/release_build.sh" "${upload_args[@]}"
}

main "$@"
