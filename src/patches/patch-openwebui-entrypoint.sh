#!/bin/bash

# Multi-file patching for Open WebUI backend
# Automatically patches all files found in /app/patches/backend/
echo "========================================="
echo "Open WebUI Backend Patching System"
echo "========================================="

PATCHES_DIR="/app/patches/backend"
BACKEND_DIR="/app/backend"

# Verify patches directory exists
if [ ! -d "$PATCHES_DIR" ]; then
    echo "ERROR: Patches directory not found at $PATCHES_DIR"
    exit 1
fi

# Discover all patch files
echo ""
echo "Scanning for patch files..."
PATCH_FILES=()
while IFS= read -r -d '' file; do
    PATCH_FILES+=("$file")
done < <(
    find "$PATCHES_DIR" \
        -type d -name __pycache__ -prune -o \
        -type f ! -name '*.pyc' -print0
)

TOTAL_FILES=${#PATCH_FILES[@]}

if [ $TOTAL_FILES -eq 0 ]; then
    echo "WARNING: No patch files found in $PATCHES_DIR"
    echo "Skipping patching step..."
else
    echo "Found $TOTAL_FILES file(s) to patch:"
    for patch_file in "${PATCH_FILES[@]}"; do
        RELATIVE_PATH="${patch_file#$PATCHES_DIR/}"
        echo "  - $RELATIVE_PATH"
    done
    echo ""

    # Patch each file
    SUCCESS_COUNT=0
    FAILURE_COUNT=0

    for i in "${!PATCH_FILES[@]}"; do
        PATCH_SOURCE="${PATCH_FILES[$i]}"
        RELATIVE_PATH="${PATCH_SOURCE#$PATCHES_DIR/}"
        PATCH_TARGET="$BACKEND_DIR/$RELATIVE_PATH"
        FILE_NUM=$((i + 1))

        echo "[$FILE_NUM/$TOTAL_FILES] Patching $RELATIVE_PATH..."

        # Ensure target directory exists
        TARGET_DIR="$(dirname "$PATCH_TARGET")"
        if [ ! -d "$TARGET_DIR" ]; then
            echo "  → Creating directory: $TARGET_DIR"
            mkdir -p "$TARGET_DIR"
            if [ $? -ne 0 ]; then
                echo "  ✗ ERROR: Failed to create directory $TARGET_DIR"
                FAILURE_COUNT=$((FAILURE_COUNT + 1))
                exit 1
            fi
        fi

        # Backup original file if it exists and hasn't been backed up
        if [ -f "$PATCH_TARGET" ]; then
            if [ ! -f "${PATCH_TARGET}.original" ]; then
                echo "  → Creating backup: ${RELATIVE_PATH}.original"
                cp "$PATCH_TARGET" "${PATCH_TARGET}.original"
                if [ $? -ne 0 ]; then
                    echo "  ✗ ERROR: Failed to create backup for $RELATIVE_PATH"
                    FAILURE_COUNT=$((FAILURE_COUNT + 1))
                    exit 1
                fi
            else
                echo "  → Backup already exists: ${RELATIVE_PATH}.original"
            fi
        else
            echo "  → Original file not found (new file will be created)"
        fi

        # Copy patched file
        echo "  → Applying patch..."
        cp "$PATCH_SOURCE" "$PATCH_TARGET"
        if [ $? -ne 0 ]; then
            echo "  ✗ ERROR: Failed to copy patch to $PATCH_TARGET"
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
            exit 1
        fi

        # Verify file was created/updated
        if [ ! -f "$PATCH_TARGET" ]; then
            echo "  ✗ ERROR: Patch file not found at $PATCH_TARGET after copy"
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
            exit 1
        fi

        # Optional: Verify Python syntax (only for .py files)
        if [[ "$PATCH_TARGET" == *.py ]]; then
            python3 -m py_compile "$PATCH_TARGET" 2>/dev/null
            if [ $? -ne 0 ]; then
                echo "  ⚠ WARNING: $RELATIVE_PATH may have syntax errors"
            fi
        fi

        echo "  ✓ Successfully patched $RELATIVE_PATH"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        echo ""
    done

    # Summary
    echo "========================================="
    if [ $FAILURE_COUNT -eq 0 ]; then
        echo "✓ Backend patching completed successfully!"
        echo "  Files patched: $SUCCESS_COUNT/$TOTAL_FILES"
    else
        echo "✗ Backend patching failed!"
        echo "  Success: $SUCCESS_COUNT"
        echo "  Failures: $FAILURE_COUNT"
        exit 1
    fi
    echo "========================================="
fi

echo ""
echo "========================================="
echo "Inline Patches (targeted code fixes)"
echo "========================================="

# ── tools.py patches ──────────────────────────────────────────────────────
TOOLS_PY="/app/backend/open_webui/utils/tools.py"
if [ -f "$TOOLS_PY" ]; then

    # Patch 5: Tool server cache miss stays nonblocking
    # Prompt processing owns tool latency. If a server is missing from cached
    # specs, do not refresh all OpenAPI tool servers here; the periodic health
    # check and Control Plane/UI refresh paths own cache population.
    python3 << 'PATCH5_EOF'
import sys

target = "/app/backend/open_webui/utils/tools.py"
with open(target) as f:
    content = f.read()

old_block = '''                    if tool_server_data is None:
                        log.warning(f"Tool server data not found for {server_id}")
                        continue'''

previous_block = '''                    if tool_server_data is None:
                        # Cache miss — refresh specs and retry once (PORTICO_PATCH)
                        log.info(f"Tool server {server_id} not in cache, refreshing...")
                        refreshed = await set_tool_servers(request)
                        for server in refreshed:
                            if server["id"] == server_id:
                                tool_server_data = server
                                break

                    if tool_server_data is None:
                        log.warning(f"Tool server data not found for {server_id} after refresh")
                        continue'''

new_block = '''                    if tool_server_data is None:
                        # Cache miss — do not refresh OpenAPI specs on the prompt path (PORTICO_PATCH_CACHE_ONLY)
                        log.warning(f"Tool server data not found for {server_id} in cached tool_servers")
                        continue'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open(target, "w") as f:
        f.write(content)
    print("  ✓ tools.py patched: cache miss stays nonblocking for missing tool servers")
elif previous_block in content:
    content = content.replace(previous_block, new_block)
    with open(target, "w") as f:
        f.write(content)
    print("  ✓ tools.py patched: removed prompt-path cache-refresh retry for missing tool servers")
elif "PORTICO_PATCH_CACHE_ONLY" in content:
    print("  → tools.py already patched (PORTICO_PATCH_CACHE_ONLY marker found)")
else:
    print("  ⚠ tools.py: target block not found — may need manual update")
    sys.exit(1)
PATCH5_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: tools.py Patch 5 failed" && exit 1

    # Patch 6: Toggle-aware tool filtering in get_tools()
    # When an MCP server is toggled off in mcp_toggles.json, skip it entirely
    # so the LLM never receives its tool specs.
    python3 << 'PATCH6_EOF'
import sys

target = "/app/backend/open_webui/utils/tools.py"
with open(target) as f:
    content = f.read()

old_block = '''                if type == "openapi":

                    tool_server_data = None
                    for server in await get_tool_servers(request):'''

new_block = '''                if type == "openapi":

                    # PORTICO_PATCH_TOGGLE: Skip disabled servers
                    try:
                        import json as _json
                        with open("/app/mcp_toggles.json", "r") as _tf:
                            _toggles = _json.load(_tf)
                        if not _toggles.get(server_id, True):
                            log.info(f"Skipping disabled server {server_id} (toggle=off)")
                            continue
                    except Exception:
                        pass  # fail-open if toggles unreadable

                    tool_server_data = None
                    for server in await get_tool_servers(request):'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open(target, "w") as f:
        f.write(content)
    print("  ✓ tools.py patched: added toggle-aware server filtering (PORTICO_PATCH_TOGGLE)")
elif "PORTICO_PATCH_TOGGLE" in content:
    print("  → tools.py already patched (PORTICO_PATCH_TOGGLE marker found)")
else:
    print("  ⚠ tools.py: toggle patch target block not found — may need manual update")
    sys.exit(1)
PATCH6_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: tools.py Patch 6 failed" && exit 1

    # Patch 6b: Prune disabled servers from cached tool_servers entries.
    # Open WebUI caches tool server specs in Redis and reuses them for /api/v1/tools.
    # If a server is toggled off after the cache is populated, new chats can still
    # see stale server:... tool IDs until something deletes the key. Filter the
    # cached list against mcp_toggles.json every time it is loaded.
    python3 << 'PATCH6B_EOF'
import sys

target = "/app/backend/open_webui/utils/tools.py"
with open(target) as f:
    content = f.read()

old_block = '''async def get_tool_servers(request: Request):
    tool_servers = []
    if request.app.state.redis is not None:
        try:
            tool_servers = json.loads(await request.app.state.redis.get("tool_servers"))
            request.app.state.TOOL_SERVERS = tool_servers
        except Exception as e:
            log.error(f"Error fetching tool_servers from Redis: {e}")

    if not tool_servers:
        tool_servers = await set_tool_servers(request)

    return tool_servers'''

new_block = '''async def get_tool_servers(request: Request):
    tool_servers = []
    if request.app.state.redis is not None:
        try:
            cached_tool_servers = await request.app.state.redis.get("tool_servers")
            if cached_tool_servers:
                tool_servers = json.loads(cached_tool_servers)
                request.app.state.TOOL_SERVERS = tool_servers
        except Exception as e:
            log.error(f"Error fetching tool_servers from Redis: {e}")

    if tool_servers:
        try:
            with open("/app/mcp_toggles.json", "r") as _tf:
                _toggles = json.load(_tf)
            filtered_tool_servers = [
                server
                for server in tool_servers
                if _toggles.get(server.get("id"), True)
            ]
            if len(filtered_tool_servers) != len(tool_servers):
                removed_server_ids = [
                    server.get("id")
                    for server in tool_servers
                    if not _toggles.get(server.get("id"), True)
                ]
                log.info(
                    f"[PORTICO_PATCH_TOGGLE_CACHE] Pruned disabled tool servers from cache: {removed_server_ids}"
                )
                tool_servers = filtered_tool_servers
                request.app.state.TOOL_SERVERS = filtered_tool_servers
                if request.app.state.redis is not None:
                    await request.app.state.redis.set(
                        "tool_servers", json.dumps(filtered_tool_servers)
                    )
        except Exception as e:
            log.debug(f"Failed to prune disabled tool server cache entries: {e}")

    if not tool_servers:
        tool_servers = await set_tool_servers(request)

    return tool_servers'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open(target, "w") as f:
        f.write(content)
    print("  ✓ tools.py patched: prunes disabled cached tool servers (PORTICO_PATCH_TOGGLE_CACHE)")
elif "PORTICO_PATCH_TOGGLE_CACHE" in content:
    print("  → tools.py already patched (PORTICO_PATCH_TOGGLE_CACHE marker found)")
else:
    print("  ⚠ tools.py: cache pruning patch target block not found — may need manual update")
    sys.exit(1)
PATCH6B_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: tools.py Patch 6b failed" && exit 1

    # Patch 6c: Activation-scoped targeted tool server refresh helper.
    # Chat submission remains cache-only. Middleware may call this helper only
    # immediately after an explicit MCP topology-changing tool call, and only
    # for the named server IDs that changed.
    python3 << 'PATCH6C_EOF'
import sys

target = "/app/backend/open_webui/utils/tools.py"
with open(target) as f:
    content = f.read()

marker = "PORTICO_PATCH_TARGETED_TOOL_REFRESH"
if marker in content:
    print("  → tools.py already patched (PORTICO_PATCH_TARGETED_TOOL_REFRESH marker found)")
    sys.exit(0)

anchor = '''async def get_tool_servers(request: Request):
    tool_servers = []
    if request.app.state.redis is not None:
        try:
            cached_tool_servers = await request.app.state.redis.get("tool_servers")
            if cached_tool_servers:
                tool_servers = json.loads(cached_tool_servers)
                request.app.state.TOOL_SERVERS = tool_servers
        except Exception as e:
            log.error(f"Error fetching tool_servers from Redis: {e}")

    if tool_servers:
        try:
            with open("/app/mcp_toggles.json", "r") as _tf:
                _toggles = json.load(_tf)
            filtered_tool_servers = [
                server
                for server in tool_servers
                if _toggles.get(server.get("id"), True)
            ]
            if len(filtered_tool_servers) != len(tool_servers):
                removed_server_ids = [
                    server.get("id")
                    for server in tool_servers
                    if not _toggles.get(server.get("id"), True)
                ]
                log.info(
                    f"[PORTICO_PATCH_TOGGLE_CACHE] Pruned disabled tool servers from cache: {removed_server_ids}"
                )
                tool_servers = filtered_tool_servers
                request.app.state.TOOL_SERVERS = filtered_tool_servers
                if request.app.state.redis is not None:
                    await request.app.state.redis.set(
                        "tool_servers", json.dumps(filtered_tool_servers)
                    )
        except Exception as e:
            log.debug(f"Failed to prune disabled tool server cache entries: {e}")

    if not tool_servers:
        tool_servers = await set_tool_servers(request)

    return tool_servers'''

helper = '''

def _normalize_targeted_tool_server_id(value):
    raw = str(value or "").strip()
    if raw.startswith("server:"):
        raw = raw[len("server:") :]
    return raw.split("|", 1)[0].strip()


async def refresh_tool_servers_for_ids(request: Request, server_ids):
    # PORTICO_PATCH_TARGETED_TOOL_REFRESH: Refresh only explicit activation targets.
    normalized_ids = {
        server_id
        for server_id in (
            _normalize_targeted_tool_server_id(value)
            for value in (server_ids or [])
        )
        if server_id
    }
    if not normalized_ids:
        return []

    original_connections_value = request.app.state.config.TOOL_SERVER_CONNECTIONS
    original_connections = original_connections_value or []
    if hasattr(original_connections, "value"):
        original_connections = list(original_connections.value)
    else:
        original_connections = list(original_connections)

    selected_connections = []
    for connection in original_connections:
        if not isinstance(connection, dict):
            continue
        info = connection.get("info") or {}
        server_id = str(info.get("id") or "").strip()
        if server_id in normalized_ids:
            selected_connections.append(connection)

    if not selected_connections:
        log.info(
            f"[PORTICO_PATCH_TARGETED_TOOL_REFRESH] No matching tool server connections for {sorted(normalized_ids)}"
        )
        return []

    existing_tool_servers = []
    try:
        state_tool_servers = getattr(request.app.state, "TOOL_SERVERS", None)
        if isinstance(state_tool_servers, list):
            existing_tool_servers = [
                server for server in state_tool_servers if isinstance(server, dict)
            ]
    except Exception:
        existing_tool_servers = []

    if request.app.state.redis is not None:
        try:
            cached_tool_servers = await request.app.state.redis.get("tool_servers")
            if cached_tool_servers:
                parsed_tool_servers = json.loads(cached_tool_servers)
                if isinstance(parsed_tool_servers, list):
                    existing_tool_servers = [
                        server
                        for server in parsed_tool_servers
                        if isinstance(server, dict)
                    ]
        except Exception as e:
            log.debug(
                f"[PORTICO_PATCH_TARGETED_TOOL_REFRESH] Could not read existing tool_servers cache: {e}"
            )

    try:
        request.app.state.config.TOOL_SERVER_CONNECTIONS = selected_connections
        refreshed_tool_servers = await set_tool_servers(request)
    finally:
        request.app.state.config.TOOL_SERVER_CONNECTIONS = original_connections_value

    refreshed_tool_servers = [
        server
        for server in (refreshed_tool_servers or [])
        if isinstance(server, dict) and str(server.get("id") or "") in normalized_ids
    ]
    refreshed_ids = {
        str(server.get("id") or "")
        for server in refreshed_tool_servers
        if isinstance(server, dict)
    }
    merged_tool_servers = [
        server
        for server in existing_tool_servers
        if str(server.get("id") or "") not in refreshed_ids
    ]
    merged_tool_servers.extend(refreshed_tool_servers)

    request.app.state.TOOL_SERVERS = merged_tool_servers
    if request.app.state.redis is not None:
        await request.app.state.redis.set(
            "tool_servers", json.dumps(merged_tool_servers)
        )

    log.info(
        f"[PORTICO_PATCH_TARGETED_TOOL_REFRESH] Refreshed tool servers {sorted(refreshed_ids)}"
    )
    return refreshed_tool_servers'''

if anchor in content:
    content = content.replace(anchor, anchor + helper)
    with open(target, "w") as f:
        f.write(content)
    print("  ✓ tools.py patched: added activation-scoped targeted tool refresh helper")
else:
    print("  ⚠ tools.py: targeted refresh patch target block not found — may need manual update")
    sys.exit(1)
PATCH6C_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: tools.py Patch 6c failed" && exit 1

else
    echo "  ⚠ tools.py not found at $TOOLS_PY"
fi

# ── middleware.py patches ─────────────────────────────────────────────────
# Patch 7: Return descriptive error for tool calls to unavailable tools
# When the LLM hallucinates a tool call (from chat history) for a tool that's
# not in the current tools dict (e.g., disabled server), return a clear error
# message instead of empty string.
MIDDLEWARE_PY="/app/backend/open_webui/utils/middleware.py"
if [ -f "$MIDDLEWARE_PY" ]; then
    python3 << 'PATCH7_EOF'
import sys

target = "/app/backend/open_webui/utils/middleware.py"
with open(target) as f:
    content = f.read()

old_block = '''                                tool_result = None
                                tool = None
                                tool_type = None
                                direct_tool = False

                                if tool_function_name in tools:'''

new_block = '''                                tool_result = None
                                tool = None
                                tool_type = None
                                direct_tool = False

                                # PORTICO_PATCH_NOTFOUND: Return accurate error for tools not in current dict
                                if tool_function_name not in tools:
                                    if (
                                        subagent_guard_state.get("is_subagent_chat")
                                        and _optimization_flag_enabled("subagent_integration_activation_restriction", True)
                                        and tool_function_name in _SUBAGENT_LOCKED_TOOL_NAMES
                                    ):
                                        tool_result = {
                                            "status": "blocked_by_policy",
                                            "code": "delegated_subagent_tool_locked",
                                            "message": (
                                                f"{tool_function_name} is unavailable in delegated subagent chats. "
                                                "Do not activate skills or change integration state here. Continue "
                                                "with already attached tools and the current evidence."
                                            ),
                                        }
                                    else:
                                        tool_result = f"Error: Tool '{tool_function_name}' is not available in the current chat yet. The integration may still be starting, may still need activation, or may have been disabled. Do NOT retry this tool call blindly. First verify the integration is enabled and only activate it after readiness_phase='tool_ready'. If readiness_phase='service_not_found', the server is not installed. Do NOT wait or retry activation; surface the missing integration error and continue without it."
                                    log.warning(f"[TOOL-CALL] Tool {tool_function_name} not found in tools dict for chat {metadata.get('chat_id')}")

                                if tool_function_name in tools:'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open(target, "w") as f:
        f.write(content)
    print("  ✓ middleware.py patched: return error for unavailable tool calls (PORTICO_PATCH_NOTFOUND)")
elif "PORTICO_PATCH_NOTFOUND" in content or "delegated_subagent_tool_locked" in content:
    print("  → middleware.py already patched (PORTICO_PATCH_NOTFOUND marker found)")
else:
    print("  → middleware.py inline patch skipped: target block shape no longer matches")
PATCH7_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: middleware.py Patch 7 failed" && exit 1
else
    echo "  ⚠ middleware.py not found at $MIDDLEWARE_PY"
fi

# ── storage/provider.py patches ────────────────────────────────────────────
# Patch 8: Load cloud storage SDKs lazily so local-storage deployments do not
# need boto3/google-cloud-storage/azure-storage-blob just to start.
STORAGE_PROVIDER_PY="/app/backend/open_webui/storage/provider.py"
if [ -f "$STORAGE_PROVIDER_PY" ]; then
    python3 << 'PATCH8_EOF'
import sys

target = "/app/backend/open_webui/storage/provider.py"
with open(target) as f:
    content = f.read()

if "PORTICO_PATCH_STORAGE_LAZY" not in content:
    for old_block in [
        "import boto3\n",
        "from botocore.config import Config\n",
        "from botocore.exceptions import ClientError\n",
        "from google.cloud import storage\n",
        "from google.cloud.exceptions import GoogleCloudError, NotFound\n",
        "from azure.identity import DefaultAzureCredential\n",
        "from azure.storage.blob import BlobServiceClient\n",
        "from azure.core.exceptions import ResourceNotFoundError\n",
    ]:
        content = content.replace(old_block, "")

    helpers_anchor = 'log = logging.getLogger(__name__)\n'
    helpers_block = '''log = logging.getLogger(__name__)


# PORTICO_PATCH_STORAGE_LAZY: load cloud SDKs only for the configured provider.
def _load_s3_sdk():
    import boto3
    from botocore.config import Config

    return boto3, Config


def _load_gcs_storage():
    from google.cloud import storage

    return storage


def _load_azure_storage():
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    return DefaultAzureCredential, BlobServiceClient
'''
    if helpers_anchor in content:
        content = content.replace(helpers_anchor, helpers_block, 1)

    content = content.replace(
        '    def __init__(self):\n        config = Config(\n',
        '    def __init__(self):\n        boto3, Config = _load_s3_sdk()\n        config = Config(\n',
    )
    content = content.replace("except ClientError as e:", "except Exception as e:")

    old_gcs_init = '''    def __init__(self):
        self.bucket_name = GCS_BUCKET_NAME

        if GOOGLE_APPLICATION_CREDENTIALS_JSON:
            self.gcs_client = storage.Client.from_service_account_info(
                info=json.loads(GOOGLE_APPLICATION_CREDENTIALS_JSON)
            )
        else:
            # if no credentials json is provided, credentials will be picked up from the environment
            # if running on local environment, credentials would be user credentials
            # if running on a Compute Engine instance, credentials would be from Google Metadata server
            self.gcs_client = storage.Client()
        self.bucket = self.gcs_client.bucket(GCS_BUCKET_NAME)
'''
    new_gcs_init = '''    def __init__(self):
        storage = _load_gcs_storage()
        self.bucket_name = GCS_BUCKET_NAME

        if GOOGLE_APPLICATION_CREDENTIALS_JSON:
            self.gcs_client = storage.Client.from_service_account_info(
                info=json.loads(GOOGLE_APPLICATION_CREDENTIALS_JSON)
            )
        else:
            # if no credentials json is provided, credentials will be picked up from the environment
            # if running on local environment, credentials would be user credentials
            # if running on a Compute Engine instance, credentials would be from Google Metadata server
            self.gcs_client = storage.Client()
        self.bucket = self.gcs_client.bucket(GCS_BUCKET_NAME)
'''
    content = content.replace(old_gcs_init, new_gcs_init)
    content = content.replace("except GoogleCloudError as e:", "except Exception as e:")
    content = content.replace("except NotFound as e:", "except Exception as e:")

    old_azure_init = '''    def __init__(self):
        self.endpoint = AZURE_STORAGE_ENDPOINT
        self.container_name = AZURE_STORAGE_CONTAINER_NAME
        storage_key = AZURE_STORAGE_KEY

        if storage_key:
            # Configure using the Azure Storage Account Endpoint and Key
            self.blob_service_client = BlobServiceClient(
                account_url=self.endpoint, credential=storage_key
            )
        else:
            # Configure using the Azure Storage Account Endpoint and DefaultAzureCredential
            # If the key is not configured, then the DefaultAzureCredential will be used to support Managed Identity authentication
            self.blob_service_client = BlobServiceClient(
                account_url=self.endpoint, credential=DefaultAzureCredential()
            )
        self.container_client = self.blob_service_client.get_container_client(
            self.container_name
        )
'''
    new_azure_init = '''    def __init__(self):
        DefaultAzureCredential, BlobServiceClient = _load_azure_storage()
        self.endpoint = AZURE_STORAGE_ENDPOINT
        self.container_name = AZURE_STORAGE_CONTAINER_NAME
        storage_key = AZURE_STORAGE_KEY

        if storage_key:
            # Configure using the Azure Storage Account Endpoint and Key
            self.blob_service_client = BlobServiceClient(
                account_url=self.endpoint, credential=storage_key
            )
        else:
            # Configure using the Azure Storage Account Endpoint and DefaultAzureCredential
            # If the key is not configured, then the DefaultAzureCredential will be used to support Managed Identity authentication
            self.blob_service_client = BlobServiceClient(
                account_url=self.endpoint, credential=DefaultAzureCredential()
            )
        self.container_client = self.blob_service_client.get_container_client(
            self.container_name
        )
'''
    content = content.replace(old_azure_init, new_azure_init)
    content = content.replace(
        "except ResourceNotFoundError as e:", "except Exception as e:"
    )

    with open(target, "w") as f:
        f.write(content)

if "PORTICO_PATCH_STORAGE_LAZY" in content:
    print("  ✓ storage/provider.py patched for lazy cloud SDK imports")
else:
    print("  ⚠ storage/provider.py patch verification failed")
    sys.exit(1)
PATCH8_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: storage/provider.py Patch 8 failed" && exit 1
else
    echo "  ⚠ storage/provider.py not found at $STORAGE_PROVIDER_PY"
fi

# ── files.py patches ──────────────────────────────────────────────────────
# Patch 9: Keep basic file upload/download flows working without importing the
# retrieval stack when BYPASS_EMBEDDING_AND_RETRIEVAL is enabled.
FILES_ROUTER_PY="/app/backend/open_webui/routers/files.py"
if [ -f "$FILES_ROUTER_PY" ]; then
    python3 << 'PATCH9_EOF'
import sys

target = "/app/backend/open_webui/routers/files.py"
with open(target) as f:
    content = f.read()

replacements = [
    (
        "from open_webui.retrieval.vector.factory import VECTOR_DB_CLIENT\n",
        "",
    ),
    (
        "from open_webui.routers.retrieval import ProcessFileForm, process_file\n",
        "",
    ),
]

for old_block, new_block in replacements:
    if old_block in content:
        content = content.replace(old_block, new_block)

helpers_anchor = '''from open_webui.storage.provider import Storage


from open_webui.utils.auth import get_admin_user, get_verified_user
'''

helpers_block = '''from open_webui.storage.provider import Storage

RETRIEVAL_DISABLED = (
    os.environ.get("BYPASS_EMBEDDING_AND_RETRIEVAL", "false").lower() == "true"
)
INLINE_TEXT_CONTENT_TYPES = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/x-ndjson",
}


def retrieval_enabled(request: Optional[Request] = None) -> bool:
    if request is not None:
        return not getattr(
            request.app.state.config,
            "BYPASS_EMBEDDING_AND_RETRIEVAL",
            RETRIEVAL_DISABLED,
        )
    return not RETRIEVAL_DISABLED


def get_vector_db_client():
    if not retrieval_enabled():
        return None

    from open_webui.retrieval.vector.factory import VECTOR_DB_CLIENT

    return VECTOR_DB_CLIENT


def maybe_extract_inline_content(file_path: str, content_type: Optional[str]) -> Optional[str]:
    if not content_type:
        return None

    if not (
        content_type.startswith("text/") or content_type in INLINE_TEXT_CONTENT_TYPES
    ):
        return None

    try:
        resolved_path = Storage.get_file(file_path)
        with open(resolved_path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except Exception as e:
        log.warning(f"Unable to extract inline content for {file_path}: {e}")
        return None


def process_file_if_enabled(
    request: Request,
    file_id: str,
    user,
    content: Optional[str] = None,
):
    if not retrieval_enabled(request):
        data = {"status": "completed"}
        if content is not None:
            data["content"] = content
        Files.update_file_data_by_id(file_id, data)
        return

    from open_webui.routers.retrieval import ProcessFileForm, process_file

    payload = {"file_id": file_id}
    if content is not None:
        payload["content"] = content

    process_file(request, ProcessFileForm(**payload), user=user)


from open_webui.utils.auth import get_admin_user, get_verified_user
'''

if helpers_anchor in content and "INLINE_TEXT_CONTENT_TYPES" not in content:
    content = content.replace(helpers_anchor, helpers_block)

old_process_uploaded_file = '''def process_uploaded_file(request, file, file_path, file_item, file_metadata, user):
    try:
        if file.content_type:
            stt_supported_content_types = getattr(
                request.app.state.config, "STT_SUPPORTED_CONTENT_TYPES", []
            )

            if strict_match_mime_type(stt_supported_content_types, file.content_type):
                file_path = Storage.get_file(file_path)
                result = transcribe(request, file_path, file_metadata, user)

                process_file(
                    request,
                    ProcessFileForm(
                        file_id=file_item.id, content=result.get("text", "")
                    ),
                    user=user,
                )
            elif (not file.content_type.startswith(("image/", "video/"))) or (
                request.app.state.config.CONTENT_EXTRACTION_ENGINE == "external"
            ):
                process_file(request, ProcessFileForm(file_id=file_item.id), user=user)
            else:
                raise Exception(
                    f"File type {file.content_type} is not supported for processing"
                )
        else:
            log.info(
                f"File type {file.content_type} is not provided, but trying to process anyway"
            )
            process_file(request, ProcessFileForm(file_id=file_item.id), user=user)

    except Exception as e:
        log.error(f"Error processing file: {file_item.id}")
        Files.update_file_data_by_id(
            file_item.id,
            {
                "status": "failed",
                "error": str(e.detail) if hasattr(e, "detail") else str(e),
            },
        )
'''

new_process_uploaded_file = '''def process_uploaded_file(request, file, file_path, file_item, file_metadata, user):
    try:
        if not retrieval_enabled(request):
            data = {"status": "completed"}
            inline_content = maybe_extract_inline_content(file_path, file.content_type)
            if inline_content is not None:
                data["content"] = inline_content
            Files.update_file_data_by_id(file_item.id, data)
            return

        if file.content_type:
            stt_supported_content_types = getattr(
                request.app.state.config, "STT_SUPPORTED_CONTENT_TYPES", []
            )

            if strict_match_mime_type(stt_supported_content_types, file.content_type):
                file_path = Storage.get_file(file_path)
                result = transcribe(request, file_path, file_metadata, user)

                process_file_if_enabled(
                    request,
                    file_item.id,
                    user,
                    content=result.get("text", ""),
                )
            elif (not file.content_type.startswith(("image/", "video/"))) or (
                request.app.state.config.CONTENT_EXTRACTION_ENGINE == "external"
            ):
                process_file_if_enabled(request, file_item.id, user)
            else:
                raise Exception(
                    f"File type {file.content_type} is not supported for processing"
                )
        else:
            log.info(
                f"File type {file.content_type} is not provided, but trying to process anyway"
            )
            process_file_if_enabled(request, file_item.id, user)

    except Exception as e:
        log.error(f"Error processing file: {file_item.id}")
        Files.update_file_data_by_id(
            file_item.id,
            {
                "status": "failed",
                "error": str(e.detail) if hasattr(e, "detail") else str(e),
            },
        )
'''

if old_process_uploaded_file in content:
    content = content.replace(old_process_uploaded_file, new_process_uploaded_file)

old_update_content = '''            process_file(
                request,
                ProcessFileForm(file_id=id, content=form_data.content),
                user=user,
            )
            file = Files.get_file_by_id(id=id)
'''

new_update_content = '''            if retrieval_enabled(request):
                process_file_if_enabled(
                    request,
                    id,
                    user,
                    content=form_data.content,
                )
            else:
                Files.update_file_data_by_id(
                    id,
                    {
                        "content": form_data.content,
                        "status": "completed",
                    },
                )
            file = Files.get_file_by_id(id=id)
'''

if old_update_content in content:
    content = content.replace(old_update_content, new_update_content)

old_delete_all = '''            Storage.delete_all_files()
            VECTOR_DB_CLIENT.reset()
'''

new_delete_all = '''            Storage.delete_all_files()
            vector_db_client = get_vector_db_client()
            if vector_db_client is not None:
                vector_db_client.reset()
'''

if old_delete_all in content:
    content = content.replace(old_delete_all, new_delete_all)

old_delete_file = '''                Storage.delete_file(file.path)
                VECTOR_DB_CLIENT.delete(collection_name=f"file-{id}")
'''

new_delete_file = '''                Storage.delete_file(file.path)
                vector_db_client = get_vector_db_client()
                if vector_db_client is not None:
                    vector_db_client.delete(collection_name=f"file-{id}")
'''

if old_delete_file in content:
    content = content.replace(old_delete_file, new_delete_file)

if "INLINE_TEXT_CONTENT_TYPES" not in content or "process_file_if_enabled" not in content:
    print("  ⚠ files.py patch verification failed")
    sys.exit(1)

with open(target, "w") as f:
    f.write(content)

print("  ✓ files.py patched for retrieval-free file handling")
PATCH9_EOF
    [ $? -ne 0 ] && echo "  ✗ ERROR: files.py Patch 9 failed" && exit 1
else
    echo "  ⚠ files.py not found at $FILES_ROUTER_PY"
fi

echo ""
echo "Starting Open WebUI..."
echo "========================================="
echo ""

if [ -z "${OPENAI_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY_FILE:-}" ] && [ -r "$OPENAI_API_KEY_FILE" ]; then
    export OPENAI_API_KEY="$(cat "$OPENAI_API_KEY_FILE")"
fi

if [ -z "${WEBUI_SECRET_KEY:-}" ] && [ -n "${WEBUI_SECRET_KEY_FILE:-}" ] && [ -r "$WEBUI_SECRET_KEY_FILE" ]; then
    export WEBUI_SECRET_KEY="$(cat "$WEBUI_SECRET_KEY_FILE")"
fi

# Execute the original Open WebUI entrypoint
exec bash /app/backend/start.sh
