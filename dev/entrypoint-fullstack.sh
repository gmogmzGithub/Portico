#!/bin/bash
# Full-stack development entrypoint for Open WebUI with hot-reload
#
# Based on: https://docs.openwebui.com/getting-started/advanced-topics/development/
#
# This script:
# 1. Restores a seeded Open WebUI checkout into the writable Docker volume
# 2. Falls back to reinstalling deps only if the seed restore is unavailable
# 3. Applies patches from mounted volumes
# 4. Starts backend with uvicorn --reload (port 8080)
# 5. Starts frontend with Vite dev server (port 5173)
#
# The frontend Vite dev server proxies API calls to the backend.

set -e

SOURCE_DIR="/app/source"
PATCHES_DIR="/app/patches/frontend"
BACKEND_PATCHES_DIR="/app/patches/backend"
DEFAULT_OPENWEBUI_VERSION="v0.6.43"
OPENWEBUI_VERSION="${OPENWEBUI_VERSION:-$DEFAULT_OPENWEBUI_VERSION}"
PREBUILT_VENV_DIR="/opt/open-webui-venv"
SEEDED_SOURCE_DIR="/opt/open-webui-seed"

echo "=== Open WebUI Full-Stack Development Mode ==="
echo "Source: $SOURCE_DIR"
echo "Backend patches: $BACKEND_PATCHES_DIR"
echo "Frontend patches: $PATCHES_DIR"
echo "Target version: $OPENWEBUI_VERSION"
echo ""

# Install system dependencies only if the runtime image is unexpectedly missing them.
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null || ! command -v inotifywait &> /dev/null; then
    echo ">>> Installing system dependencies..."
    apt-get update && apt-get install -y --no-install-recommends nodejs npm inotify-tools && rm -rf /var/lib/apt/lists/*
else
    echo ">>> System dependencies already installed"
fi

clear_source_dir() {
    rm -rf "$SOURCE_DIR"/* 2>/dev/null || true
    rm -rf "$SOURCE_DIR"/.[!.]* 2>/dev/null || true
}

get_seeded_version() {
    if [ -f "$SEEDED_SOURCE_DIR/.openwebui-version" ]; then
        cat "$SEEDED_SOURCE_DIR/.openwebui-version"
        return 0
    fi
    return 1
}

seed_matches_requested_version() {
    local seeded_version=""
    seeded_version=$(get_seeded_version 2>/dev/null || true)
    [ -n "$seeded_version" ] && [ "$seeded_version" = "$OPENWEBUI_VERSION" ]
}

restore_seeded_source() {
    if [ ! -d "$SEEDED_SOURCE_DIR" ] || [ ! -f "$SEEDED_SOURCE_DIR/package.json" ]; then
        return 1
    fi

    if ! seed_matches_requested_version; then
        return 1
    fi

    echo ">>> Restoring seeded Open WebUI $OPENWEBUI_VERSION from image..."
    mkdir -p "$SOURCE_DIR"
    clear_source_dir
    cp -a "$SEEDED_SOURCE_DIR"/. "$SOURCE_DIR"/
    echo "    Seed restore complete!"
    return 0
}

restore_seeded_node_modules() {
    if [ -d "$SOURCE_DIR/node_modules" ]; then
        return 0
    fi

    if ! seed_matches_requested_version; then
        return 1
    fi

    if [ ! -d "$SEEDED_SOURCE_DIR/node_modules" ]; then
        return 1
    fi

    echo ">>> Restoring cached npm dependencies from image..."
    cp -a "$SEEDED_SOURCE_DIR/node_modules" "$SOURCE_DIR"/
    return 0
}

# Function to get the current cached source version
get_cached_version() {
    # First check our version marker file
    if [ -f "$SOURCE_DIR/.openwebui-version" ]; then
        cat "$SOURCE_DIR/.openwebui-version"
        return 0
    fi

    # No version info available - assume it's old/unknown
    echo "unknown"
}

# Function to check if source needs to be re-cloned due to version mismatch
check_and_handle_version_mismatch() {
    local cached_version=$(get_cached_version)

    echo ">>> Checking source version..."
    echo "    Cached version: $cached_version"
    echo "    Expected version: $OPENWEBUI_VERSION"

    if [ "$cached_version" != "$OPENWEBUI_VERSION" ]; then
        echo ""
        echo ">>> VERSION MISMATCH DETECTED!"
        echo ">>> Clearing stale source to re-clone correct version..."
        echo "    (This ensures database migrations are compatible)"
        echo ""

        clear_source_dir
        return 0  # Needs re-clone
    fi

    echo "    Version OK!"
    return 1  # No mismatch
}

# Check for version mismatch before proceeding
if [ -f "$SOURCE_DIR/package.json" ]; then
    if check_and_handle_version_mismatch; then
        echo ">>> Source cleared due to version mismatch"
    fi
fi

# Restore seeded source from the image whenever the writable volume is empty.
if [ ! -f "$SOURCE_DIR/package.json" ]; then
    if ! restore_seeded_source; then
        echo "ERROR: Seeded Open WebUI source is unavailable in the image." >&2
        exit 1
    fi
fi

cd "$SOURCE_DIR"

# Restore cached npm deps from the image if the writable volume does not have them.
if [ ! -d "$SOURCE_DIR/node_modules" ]; then
    if ! restore_seeded_node_modules; then
        echo ">>> Installing npm dependencies (~2-3 min on first run)..."
        cd "$SOURCE_DIR"
        npm ci --legacy-peer-deps
        npm install --no-save --legacy-peer-deps y-protocols js-yaml
    fi
else
    echo ">>> Using cached npm dependencies"
fi

# Python deps: Prefer the image-baked venv so cold starts do not block on pip.
VENV_DIR="$SOURCE_DIR/.venv"

if [ ! -f "$VENV_DIR/bin/activate" ]; then
    if [ -f "$PREBUILT_VENV_DIR/bin/activate" ]; then
        echo ">>> Linking prebuilt Python virtualenv from image..."
        rm -rf "$VENV_DIR"
        ln -s "$PREBUILT_VENV_DIR" "$VENV_DIR"
    else
        echo ">>> Creating Python virtualenv (first run only)..."
        python -m venv "$VENV_DIR"
    fi
fi

# Activate virtualenv
source "$VENV_DIR/bin/activate"
export PATH="$VENV_DIR/bin:$PATH"

# Check if deps are already installed in the virtualenv
if ! "$VENV_DIR/bin/python" -c "import uvicorn" 2>/dev/null; then
    if [ -f "$PREBUILT_VENV_DIR/bin/activate" ] && [ "$VENV_DIR" != "$PREBUILT_VENV_DIR" ]; then
        echo ">>> Restoring prebuilt Python virtualenv from image..."
        rm -rf "$VENV_DIR"
        ln -s "$PREBUILT_VENV_DIR" "$VENV_DIR"
    fi

    if ! "$VENV_DIR/bin/python" -c "import uvicorn" 2>/dev/null; then
        echo ">>> Installing Python dependencies (~3-5min on first run)..."
        cd "$SOURCE_DIR/backend"
        "$VENV_DIR/bin/pip" install --upgrade pip
        "$VENV_DIR/bin/pip" install -r requirements.txt -U
    else
        echo ">>> Using prebuilt Python dependencies from image"
    fi
else
    echo ">>> Python dependencies already installed"
fi

cd "$SOURCE_DIR"

# Always apply patches (they may have changed)
echo ""
echo ">>> Applying frontend patches..."
if [ -d "$PATCHES_DIR" ] && [ "$(ls -A $PATCHES_DIR 2>/dev/null)" ]; then
    cp -rv "$PATCHES_DIR"/* "$SOURCE_DIR/" 2>/dev/null || true
    echo "    Frontend patches applied"
else
    echo "    No frontend patches found"
fi

echo ">>> Applying backend patches..."
if [ -d "$BACKEND_PATCHES_DIR" ] && [ "$(ls -A $BACKEND_PATCHES_DIR 2>/dev/null)" ]; then
    cp -rv "$BACKEND_PATCHES_DIR"/* "$SOURCE_DIR/backend/" 2>/dev/null || true
    echo "    Backend patches applied"
else
    echo "    No backend patches found"
fi

# Generate model-capabilities.ts if generator script exists
echo ""
echo ">>> Checking model-capabilities.ts..."
if [ -f "$SOURCE_DIR/src/lib/config/model-capabilities.ts" ]; then
    echo "    model-capabilities.ts already exists (from patches)"
elif [ -f "/app/generate-model-config.cjs" ] && [ -f "/app/model_catalog.yaml" ]; then
    echo ">>> Generating model-capabilities.ts..."
    cp /app/model_catalog.yaml "$SOURCE_DIR/"
    mkdir -p "$SOURCE_DIR/src/scripts"
    cp /app/generate-model-config.cjs "$SOURCE_DIR/src/scripts/"
    node src/scripts/generate-model-config.cjs || echo "    Warning: Failed to generate model config"
fi

# Start both servers
echo ""
echo "=== Starting Development Servers ==="
echo ""
echo "Full app:     http://localhost:8080 (Vite + API proxy)"
echo "Backend only: http://localhost:8081 (direct uvicorn access)"
echo ""
echo "Hot-reload: ENABLED for both frontend AND backend"
echo ""
echo "Edit files in:"
echo "  - src/patches/frontend/ for frontend changes (instant)"
echo "  - src/patches/backend/ for backend changes (auto-restart)"
echo ""

# Set environment variables
if [ -z "${OPENAI_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY_FILE:-}" ] && [ -r "$OPENAI_API_KEY_FILE" ]; then
    export OPENAI_API_KEY="$(cat "$OPENAI_API_KEY_FILE")"
fi

if [ -z "${WEBUI_SECRET_KEY:-}" ] && [ -n "${WEBUI_SECRET_KEY_FILE:-}" ] && [ -r "$WEBUI_SECRET_KEY_FILE" ]; then
    export WEBUI_SECRET_KEY="$(cat "$WEBUI_SECRET_KEY_FILE")"
fi

export WEBUI_AUTH=${WEBUI_AUTH:-True}
export ENABLE_PASSWORD_AUTH=${ENABLE_PASSWORD_AUTH:-False}
export ENABLE_LOGIN_FORM=${ENABLE_LOGIN_FORM:-False}
export ENABLE_SIGNUP=${ENABLE_SIGNUP:-False}
export DATA_DIR=${DATA_DIR:-/app/backend/data}
export OPENAI_API_BASE_URL=${OPENAI_API_BASE_URL:-http://llm-gateway:4000/v1}
export OPENAI_API_KEY=${OPENAI_API_KEY:-${INTERNAL_OPENAI_API_KEY:-}}

# Start backend in background with uvicorn --reload on port 8081
echo ">>> Starting backend (uvicorn with hot-reload) on port 8081..."
cd "$SOURCE_DIR/backend"
# Use virtualenv python explicitly
"$VENV_DIR/bin/python" -m uvicorn open_webui.main:app \
    --host 0.0.0.0 \
    --port 8081 \
    --reload \
    --reload-dir /app/source/backend \
    --reload-dir /app/patches/backend &

BACKEND_PID=$!
echo "    Backend started (PID: $BACKEND_PID)"

# Wait for backend to be ready
echo ">>> Waiting for backend to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:8081/health > /dev/null 2>&1; then
        echo "    Backend is ready!"
        break
    fi
    sleep 2
done

# Start file watcher for frontend patches
# This syncs changes from /app/patches/frontend to /app/source for HMR
echo ">>> Starting frontend patch watcher..."
(
    while true; do
        # Watch for file changes in patches directory
        inotifywait -r -e modify,create,delete,move "$PATCHES_DIR" 2>/dev/null
        echo "[patch-watcher] Change detected, syncing frontend patches..."
        # Small delay to handle rapid successive changes
        sleep 0.2
        # Sync patches to source
        cp -r "$PATCHES_DIR"/* "$SOURCE_DIR/" 2>/dev/null || true
        echo "[patch-watcher] Frontend patches synced"
    done
) &
WATCHER_PID=$!
echo "    Patch watcher started (PID: $WATCHER_PID)"

# Cleanup function to kill background processes on exit
cleanup() {
    echo ">>> Shutting down..."
    kill $WATCHER_PID 2>/dev/null || true
    kill $BACKEND_PID 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT EXIT

# Start frontend with Vite dev server on port 8080
# Vite will proxy API calls to backend on port 8081
# This way health check works on port 8080
echo ">>> Starting frontend (Vite with hot-reload) on port 8080..."
cd "$SOURCE_DIR"

# Check if pyodide is already downloaded (it's cached in the volume)
# This avoids re-downloading ~50MB of pyodide packages on every restart
# Note: We use & and wait instead of exec to allow cleanup trap to work
if [ -d "$SOURCE_DIR/static/pyodide" ] && [ -f "$SOURCE_DIR/static/pyodide/pyodide.js" ]; then
    echo ">>> Pyodide already cached, starting Vite directly..."
    npx vite dev --host 0.0.0.0 --port 8080 &
else
    echo ">>> First run: fetching Pyodide packages..."
    npm run dev -- --host 0.0.0.0 --port 8080 &
fi

VITE_PID=$!
echo "    Vite started (PID: $VITE_PID)"

# Wait for Vite to exit (keeps container running)
wait $VITE_PID
