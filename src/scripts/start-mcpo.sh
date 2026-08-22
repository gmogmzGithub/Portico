#!/bin/sh
set -e

# Default config file
CONFIG_FILE="${CONFIG_FILE:-mcp_config.json}"
PRESYNC_MODE="${MCPO_PRESYNC_MODE:-targeted}"
PRESYNC_RETRIES="${MCPO_PRESYNC_RETRIES:-2}"
MCPO_PORT="${MCPO_PORT:-8000}"
APP_ROOT="${MCPO_APP_ROOT:-/app}"
TEMP_DIR="${MCPO_TEMP_DIR:-/tmp/mcpo-configs}"

# Create a temporary directory for processed configs
mkdir -p "$TEMP_DIR"
TEMP_CONFIG_PATH="$TEMP_DIR/$CONFIG_FILE"
mkdir -p "$(dirname "$TEMP_CONFIG_PATH")"

# Fail fast if mcpo is not present in the image.
# Runtime package mutation in this container is intentionally disallowed.
if ! command -v mcpo > /dev/null 2>&1; then
    echo "FATAL: mcpo command not found in container image."
    echo "FATAL: runtime reinstall is disabled; rebuild the mcpo image."
    exit 1
fi

materialize_static_secret_broker_files() {
    if [ -z "${portico_STATIC_SECRET_TARGETS:-}" ]; then
        return 0
    fi

    python3 - <<'PY'
import base64
import json
import os
import sys
import urllib.error
import urllib.request

broker_url = os.environ.get(
    "portico_STATIC_SECRET_BROKER_URL",
    "http://host.docker.internal:8891/secrets/static-secret",
).strip()
targets = os.environ.get("portico_STATIC_SECRET_TARGETS", "").strip()

if not broker_url:
    print("FATAL: portico_STATIC_SECRET_BROKER_URL is empty", file=sys.stderr)
    sys.exit(78)

def fail(message):
    print(f"FATAL: {message}", file=sys.stderr)
    sys.exit(78)

def write_secret_file(path, data):
    directory = os.path.dirname(path)
    if not directory:
        fail(f"invalid static secret target path '{path}'")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    tmp_path = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass

def link_runtime_target(link_path, secret_path):
    if not link_path:
        return
    directory = os.path.dirname(link_path)
    if not directory:
        fail(f"invalid static secret link path '{link_path}'")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    if os.path.isdir(link_path) and not os.path.islink(link_path):
        fail(f"static secret link path is a directory: {link_path}")
    tmp_link = os.path.join(directory, f".{os.path.basename(link_path)}.{os.getpid()}.link")
    try:
        os.unlink(tmp_link)
    except FileNotFoundError:
        pass
    os.symlink(secret_path, tmp_link)
    os.replace(tmp_link, link_path)

for entry in [item for item in targets.split(";") if item]:
    parts = entry.split("|", 4)
    if len(parts) < 4:
        fail(f"invalid portico_STATIC_SECRET_TARGETS entry for static secret materialization")
    server_id, secret_name, write_path, token_env = [part.strip() for part in parts[:4]]
    link_path = parts[4].strip() if len(parts) >= 5 else ""
    if not server_id or not secret_name or not write_path or not token_env:
        fail("static secret materialization entry is missing required fields")
    token = os.environ.get(token_env, "").strip()
    if not token:
        fail(f"missing scoped bridge token env {token_env} for {server_id}/{secret_name}")

    request_body = json.dumps({
        "server_id": server_id,
        "secret_name": secret_name,
    }).encode("utf-8")
    request = urllib.request.Request(
        broker_url,
        data=request_body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        fail(f"static secret broker denied {server_id}/{secret_name} with HTTP {error.code}")
    except Exception as error:
        fail(f"static secret broker request failed for {server_id}/{secret_name}: {error}")

    if payload.get("server_id") != server_id or payload.get("secret_name") != secret_name:
        fail(f"static secret broker returned mismatched identity for {server_id}/{secret_name}")
    encoded = str(payload.get("value_base64") or "").strip()
    if not encoded:
        fail(f"static secret broker returned empty payload for {server_id}/{secret_name}")
    try:
        secret_bytes = base64.b64decode(encoded, validate=True)
    except Exception as error:
        fail(f"static secret broker returned invalid base64 for {server_id}/{secret_name}: {error}")
    if not secret_bytes:
        fail(f"static secret broker returned zero-byte payload for {server_id}/{secret_name}")
    write_secret_file(write_path, secret_bytes)
    link_runtime_target(link_path, write_path)
PY
}

materialize_static_secret_broker_files

# Run envsubst on the config file
echo "Processing config file: $CONFIG_FILE"
envsubst < "$APP_ROOT/$CONFIG_FILE" > "$TEMP_CONFIG_PATH"

rewrite_internal_mcp_commands_for_rust() {
    local config_path="$1"

    python3 - "$config_path" <<'PY'
import json
import shutil
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
config = json.loads(config_path.read_text())
servers = config.get("mcpServers") or {}
rewritten = []

for server_id, server_cfg in servers.items():
    command = server_cfg.get("command")
    args = list(server_cfg.get("args") or [])
    if command != "uv":
        continue

    if "--directory" not in args:
        continue

    try:
        directory = args[args.index("--directory") + 1]
    except (ValueError, IndexError):
        continue

    expected_directory = f"/app/internal-mcp/{server_id}"
    expected_entrypoint = f"{server_id}-server"

    if directory != expected_directory:
        continue

    if expected_entrypoint not in args:
        continue

    if shutil.which(expected_entrypoint) is None:
        continue

    server_cfg["command"] = expected_entrypoint
    server_cfg["args"] = []
    rewritten.append(server_id)

config_path.write_text(json.dumps(config, indent=2) + "\n")
if rewritten:
    print("Rewrote internal MCP servers for Rust backend: " + ", ".join(rewritten))
else:
    print("No internal MCP servers required Rust command rewriting")
PY
}

rewrite_npx_mcp_commands_to_native() {
    local config_path="$1"

    python3 - "$config_path" <<'PY'
import json
import shutil
import sys
from pathlib import Path

# Map npx-distributed MCP packages to a binary that is baked into the image at
# build time. When that binary is present (Docker path), rewrite the command so
# the server starts from the local install instead of fetching from the npm /
# Cloudsmith proxy on every startup. The proxy intermittently returns E403,
# which previously left gitlab-mcp unable to start. When the binary is absent
# (e.g. host-sideload mode), the npx command is left untouched.
#
# Only packages that are pre-installed in the Docker image belong here. Other
# npx-based servers (e.g. chrome-devtools-mcp) are intentionally left as live
# npx fetches and must NOT be added unless they are also baked into the image.
NPX_PACKAGE_TO_BIN = {
    "@zereight/mcp-gitlab": "mcp-gitlab",
}

config_path = Path(sys.argv[1])

# Fail open: this rewrite is a startup optimization, not a correctness
# requirement. Any unexpected error must leave the config untouched (so the
# original npx command still runs) rather than blocking MCP startup.
try:
    config = json.loads(config_path.read_text())
    servers = config.get("mcpServers") or {}
    rewritten = []

    for server_id, server_cfg in servers.items():
        if not isinstance(server_cfg, dict):
            continue
        if server_cfg.get("command") != "npx":
            continue

        args = list(server_cfg.get("args") or [])

        # The package spec is the first non-flag arg (skips npx flags like -y).
        pkg = next(
            (a for a in args if isinstance(a, str) and not a.startswith("-")),
            None,
        )
        if pkg is None:
            continue

        # Strip a trailing version/tag (e.g. @zereight/mcp-gitlab@2.1.18),
        # keeping the leading "@" of a scoped package name.
        at = pkg.rfind("@")
        bin_name = NPX_PACKAGE_TO_BIN.get(pkg[:at] if at > 0 else pkg)
        if not bin_name or shutil.which(bin_name) is None:
            continue

        # Preserve any args that follow the package spec (server-specific flags).
        server_cfg["command"] = bin_name
        server_cfg["args"] = args[args.index(pkg) + 1:]
        rewritten.append(server_id)

    if rewritten:
        # Only touch the file when something actually changed.
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        print("Rewrote npx MCP servers to baked-in binaries: " + ", ".join(rewritten))
    else:
        print("No npx MCP servers required native rewriting")
except Exception as exc:
    print(f"WARNING: npx->native rewrite skipped ({exc}); leaving config unchanged")
PY
}

get_target_sync_dirs() {
    python3 - "$TEMP_CONFIG_PATH" <<'PY'
import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
try:
    config = json.loads(cfg_path.read_text())
except Exception as exc:
    print(f"ERROR: failed to parse {cfg_path}: {exc}", file=sys.stderr)
    sys.exit(1)

dirs = set()
servers = config.get("mcpServers") or {}
for server_cfg in servers.values():
    args = server_cfg.get("args") or []
    for idx, arg in enumerate(args):
        if arg == "--directory" and idx + 1 < len(args):
            directory = args[idx + 1]
            if isinstance(directory, str) and directory.startswith("/app/internal-mcp/"):
                dirs.add(directory.rstrip("/"))
            break

for directory in sorted(dirs):
    print(directory)
PY
}

get_target_registry_docker_images() {
    python3 - "$TEMP_CONFIG_PATH" <<'PY'
import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
try:
    config = json.loads(cfg_path.read_text())
except Exception as exc:
    print(f"ERROR: failed to parse {cfg_path}: {exc}", file=sys.stderr)
    sys.exit(1)

flags_with_values = {
    "--platform",
    "--env",
    "-e",
    "--name",
    "--volume",
    "-v",
    "--mount",
    "--publish",
    "-p",
    "--label",
    "-l",
    "--network",
    "--workdir",
    "-w",
    "--user",
    "-u",
    "--entrypoint",
    "--add-host",
}

def is_registry_qualified_image(image):
    if not isinstance(image, str) or "/" not in image:
        return False
    registry = image.split("/", 1)[0]
    if registry in {"docker.io", "index.docker.io", "registry-1.docker.io"}:
        return False
    return registry == "localhost" or "." in registry or ":" in registry

def extract_registry_image(server_cfg):
    if server_cfg.get("command") != "docker":
        return None

    args = server_cfg.get("args") or []
    if not isinstance(args, list) or not args or args[0] != "run":
        return None

    platform = "default"
    consume_next = False
    pending_flag = None
    for arg in args[1:]:
        if consume_next:
            if pending_flag == "--platform" and isinstance(arg, str) and arg:
                platform = arg
            consume_next = False
            pending_flag = None
            continue

        if not isinstance(arg, str):
            continue

        if arg.startswith("--platform="):
            platform = arg.split("=", 1)[1] or "default"
            continue

        if arg in flags_with_values:
            pending_flag = arg
            consume_next = True
            continue

        if arg.startswith("-"):
            continue

        if is_registry_qualified_image(arg):
            return platform, arg
        return None

    return None

images = set()
servers = config.get("mcpServers") or {}
for server_cfg in servers.values():
    image = extract_registry_image(server_cfg)
    if image:
        images.add(image)

for platform, image in sorted(images):
    print(f"{platform}\t{image}")
PY
}

refresh_registry_docker_images() {
    echo "Refreshing registry Docker images referenced by config..."
    local image_rows=""

    if ! image_rows="$(get_target_registry_docker_images)"; then
        echo "ERROR: failed to determine registry Docker images from config"
        return 1
    fi

    if [ -z "$image_rows" ]; then
        echo "  No registry Docker images referenced in config"
        return 0
    fi

    while IFS="$(printf '\t')" read -r platform image; do
        [ -n "$image" ] || continue

        echo "  Pulling registry image: $image${platform:+ (platform: $platform)}"
        if [ "$platform" = "default" ]; then
            if docker pull "$image"; then
                continue
            fi
            if docker image inspect "$image" >/dev/null 2>&1; then
                echo "  Registry pull failed for $image; continuing with cached local image"
                continue
            fi
        else
            if docker pull --platform "$platform" "$image"; then
                continue
            fi
            if docker image inspect --platform "$platform" "$image" >/dev/null 2>&1; then
                echo "  Registry pull failed for $image on $platform; continuing with cached local image"
                continue
            fi
        fi

        echo "  Registry pull failed for $image${platform:+ on $platform} and no usable local image was found"
        return 1
    done <<EOF
$image_rows
EOF

    return 0
}

sync_single_project() {
    mcp_dir="$1"
    server_name="$(basename "$mcp_dir")"

    if [ ! -f "$mcp_dir/pyproject.toml" ]; then
        echo "  Skipping $server_name (no pyproject.toml)"
        return 0
    fi

    echo "  Syncing $server_name..."

    # Remove potentially corrupted .venv and let uv recreate it.
    if [ -d "$mcp_dir/.venv" ]; then
        remove_venv=false
        if [ ! -f "$mcp_dir/.venv/pyvenv.cfg" ]; then
            echo "    Incomplete .venv detected (missing pyvenv.cfg) for $server_name"
            remove_venv=true
        elif [ -L "$mcp_dir/.venv/bin/python" ] && ! readlink -f "$mcp_dir/.venv/bin/python" > /dev/null 2>&1; then
            echo "    Broken .venv symlink detected for $server_name"
            remove_venv=true
        fi

        if [ "$remove_venv" = true ]; then
            echo "    Removing corrupted .venv for $server_name"
            rm -rf "$mcp_dir/.venv"
        fi
    fi

    retry=0
    max_retries="$PRESYNC_RETRIES"
    while [ "$retry" -le "$max_retries" ]; do
        if UV_PROJECT_ENVIRONMENT="$mcp_dir/.venv" uv sync --directory "$mcp_dir" 2>&1; then
            echo "    $server_name synced successfully"
            return 0
        fi

        retry=$((retry + 1))
        if [ "$retry" -le "$max_retries" ]; then
            echo "    Retry $retry/$max_retries for $server_name..."
            rm -rf "$mcp_dir/.venv"
            sleep 1
        else
            echo "    WARNING: Failed to sync $server_name after $max_retries retries"
            return 1
        fi
    done
}

run_presync() {
    case "$PRESYNC_MODE" in
        none)
            echo "Pre-sync disabled (MCPO_PRESYNC_MODE=none)"
            return 0
            ;;
        all)
            echo "Pre-syncing all internal MCP servers..."
            for mcp_dir in /app/internal-mcp/*/; do
                sync_single_project "${mcp_dir%/}"
            done
            echo "Pre-sync complete"
            return 0
            ;;
        targeted)
            echo "Pre-syncing targeted internal MCP servers from config..."
            if target_dirs="$(get_target_sync_dirs)"; then
                if [ -z "$target_dirs" ]; then
                    echo "  No internal MCP directories found in config; skipping pre-sync"
                else
                    while IFS= read -r mcp_dir; do
                        [ -n "$mcp_dir" ] && sync_single_project "$mcp_dir"
                    done <<EOF
$target_dirs
EOF
                fi
                echo "Pre-sync complete"
            else
                echo "WARNING: failed to determine targeted MCP directories; skipping pre-sync"
            fi
            return 0
            ;;
        *)
            echo "WARNING: Unknown MCPO_PRESYNC_MODE='$PRESYNC_MODE', defaulting to targeted"
            PRESYNC_MODE="targeted"
            run_presync
            return 0
            ;;
    esac
}

case "${MCP_ORC_BACKEND:-python}" in
rust|rust-full)
    echo "Applying Rust backend config rewrite for internal MCP servers..."
    rewrite_internal_mcp_commands_for_rust "$TEMP_CONFIG_PATH"

    # Redirect npx-distributed MCP servers (e.g. gitlab-mcp) to their baked-in
    # binaries when present, so startup never depends on the npm/Cloudsmith
    # proxy. Only the mcp-orc-rust image bakes these binaries, so this is gated
    # to the rust backend (like the rewrite above); it is a no-op elsewhere.
    echo "Rewriting npx MCP commands to baked-in binaries where available..."
    rewrite_npx_mcp_commands_to_native "$TEMP_CONFIG_PATH" \
        || echo "WARNING: npx->native rewrite step failed; continuing with original config"
    ;;
esac

run_presync
refresh_registry_docker_images

# ============================================================================
# GENERIC RUNTIME MCP INSTALLATION
# ============================================================================
# This generic function handles runtime installation for any MCP server
# to avoid stale versions and enable automatic updates without image rebuilds.
#
# Usage:
#   install_runtime_mcp \
#     --server-id "another_mcp" \
#     --display-name "Another MCP" \
#     --zip-path "/app/another-mcp.zip" \
#     --target-dir "/app/mcp-servers/another_mcp" \
#     --zip-internal-dir "another-mcp-main" \
#     --install-command "install_another_mcp_deps"
#
# The install command function should be defined separately and handle
# server-specific dependency installation.
# ============================================================================

resolve_runtime_mcp_payload_dir() {
    local stage_dir="$1"
    local zip_internal_dir="$2"

    python3 - "$stage_dir" "$zip_internal_dir" <<'PY'
import sys
from pathlib import Path

stage_dir = Path(sys.argv[1])
zip_internal_dir = sys.argv[2]

if zip_internal_dir:
    hinted_dir = stage_dir / zip_internal_dir
    if hinted_dir.is_dir():
        print(hinted_dir)
        raise SystemExit(0)

entries = list(stage_dir.iterdir())
directories = [entry for entry in entries if entry.is_dir()]

if len(entries) == 1 and len(directories) == 1:
    print(directories[0])
    raise SystemExit(0)

if zip_internal_dir:
    print(
        f"ERROR: hinted archive root {zip_internal_dir!r} was not found under {stage_dir}",
        file=sys.stderr,
    )

print(
    f"ERROR: expected exactly one top-level directory in {stage_dir}, found {len(entries)} top-level entries",
    file=sys.stderr,
)
raise SystemExit(1)
PY
}

install_runtime_mcp() {
    # Parse arguments
    local server_id=""
    local display_name=""
    local zip_path=""
    local target_dir=""
    local zip_internal_dir=""
    local install_command=""
    
    while [ $# -gt 0 ]; do
        case $1 in
            --server-id) server_id="$2"; shift 2 ;;
            --display-name) display_name="$2"; shift 2 ;;
            --zip-path) zip_path="$2"; shift 2 ;;
            --target-dir) target_dir="$2"; shift 2 ;;
            --zip-internal-dir) zip_internal_dir="$2"; shift 2 ;;
            --install-command) install_command="$2"; shift 2 ;;
            *) echo "Unknown parameter: $1"; shift ;;
        esac
    done
    
    # Validate required parameters
    if [ -z "$server_id" ] || [ -z "$display_name" ] || [ -z "$zip_path" ] || [ -z "$target_dir" ]; then
        echo "ERROR: Missing required parameters for runtime MCP installation"
        return 1
    fi
    
    local marker_file="$target_dir/.installed_version"
    local install_root
    local stage_dir=""
    local payload_dir=""

    install_root="$(dirname "$target_dir")"
    
    # Check if server is enabled in config (skip installation if disabled)
    # The config file has already been processed by envsubst at this point
    if [ -f "$TEMP_DIR/$CONFIG_FILE" ]; then
        if ! grep -q "\"$server_id\"" "$TEMP_DIR/$CONFIG_FILE" 2>/dev/null; then
            echo "$display_name is disabled, skipping installation"
            return 0
        fi
    fi
    
    # Check if ZIP exists
    if [ ! -f "$zip_path" ]; then
        echo "WARNING: $display_name zip not found at $zip_path, skipping installation"
        return 0
    fi
    
    # Calculate ZIP checksum to detect updates
    local zip_checksum=$(md5sum "$zip_path" | awk '{print $1}')
    
    # Check if already installed with same version
    if [ -f "$marker_file" ]; then
        local installed_checksum=$(cat "$marker_file")
        if [ "$zip_checksum" = "$installed_checksum" ]; then
            echo "$display_name already installed (checksum: $(printf '%.8s' "$zip_checksum")...)"
            return 0
        else
            echo "$display_name version changed, reinstalling..."
            echo "  Old: $(printf '%.8s' "$installed_checksum")..."
            echo "  New: $(printf '%.8s' "$zip_checksum")..."
            rm -rf "$target_dir"
        fi
    else
        if [ -d "$target_dir" ]; then
            echo "  Removing stale partial installation..."
            rm -rf "$target_dir"
        fi
        echo "Installing $display_name for first time..."
    fi
    
    # Extract
    echo "  Extracting $display_name..."
    mkdir -p "$install_root"
    stage_dir="$(mktemp -d "$install_root/.${server_id}.extract.XXXXXX")" || {
        echo "ERROR: Failed to create staging directory for $display_name"
        return 1
    }
    unzip -q "$zip_path" -d "$stage_dir" || {
        echo "ERROR: Failed to extract $display_name"
        rm -rf "$stage_dir"
        return 1
    }

    if [ -n "$zip_internal_dir" ] && [ ! -d "$stage_dir/$zip_internal_dir" ]; then
        echo "  Archive root $zip_internal_dir not found; auto-detecting extracted payload directory..."
    fi

    payload_dir="$(resolve_runtime_mcp_payload_dir "$stage_dir" "$zip_internal_dir")" || {
        rm -rf "$stage_dir"
        return 1
    }

    if [ -n "$zip_internal_dir" ] && [ "$payload_dir" != "$stage_dir/$zip_internal_dir" ]; then
        echo "  Using detected archive root: $(basename "$payload_dir")"
    fi

    mv "$payload_dir" "$target_dir" || {
        echo "ERROR: Failed to move $display_name into place"
        rm -rf "$stage_dir"
        return 1
    }
    rm -rf "$stage_dir"
    
    if [ ! -d "$target_dir" ]; then
        echo "ERROR: $display_name directory not found after extraction"
        return 1
    fi
    
    # Run custom installation command if provided
    if [ -n "$install_command" ]; then
        echo "  Installing dependencies..."
        if ! $install_command "$target_dir"; then
            echo "ERROR: Failed to install $display_name dependencies"
            return 1
        fi
    fi
    
    # Mark as installed with version checksum
    echo "$zip_checksum" > "$marker_file"
    echo "$display_name installed successfully (checksum: $(printf '%.8s' "$zip_checksum")...)"
    
    cd "$APP_ROOT"
    return 0
}

# ============================================================================
# RUNTIME-INSTALLED MCPs REGISTRATION
# ============================================================================
# Add new runtime-installed MCPs here following the same pattern
# ============================================================================

if [ "${portico_PREINSTALL_RUNTIME_MCPS_ONLY:-0}" = "1" ]; then
    echo "Runtime MCP preinstall complete; exiting before mcpo startup"
    exit 0
fi

# Future runtime-installed MCPs can be added here:
# install_runtime_mcp \
#     --server-id "another_mcp" \
#     --display-name "Another MCP" \
#     --zip-path "/app/another-mcp.zip" \
#     --target-dir "/app/mcp-servers/another_mcp" \
#     --zip-internal-dir "another-mcp-main" \
#     --install-command "install_another_mcp_deps"

# Start mcpo directly using the console script
echo "Starting mcpo with processed config on port ${MCPO_PORT}..."
exec mcpo --host 0.0.0.0 --port "$MCPO_PORT" --config "$TEMP_DIR/$CONFIG_FILE"
