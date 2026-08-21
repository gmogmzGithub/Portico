#!/bin/bash
# Development entrypoint for Open WebUI with hot-reload
#
# This script:
# 1. Clones open-webui source (first run only, cached in Docker volume)
# 2. Installs npm dependencies (first run only)
# 3. Applies frontend patches from mounted volume
# 4. Generates model-capabilities.ts from model_catalog.yaml
# 5. Starts Vite dev server with hot-reload

set -e

SOURCE_DIR="/app/source"
PATCHES_DIR="/app/patches/frontend"
BACKEND_PATCHES_DIR="/app/patches/backend"
OPENWEBUI_VERSION="v0.6.41"
INITIALIZED_MARKER="$SOURCE_DIR/.dev-initialized"

echo "=== Open WebUI Development Mode ==="
echo "Source: $SOURCE_DIR"
echo "Patches: $PATCHES_DIR"
echo ""

# Install git if not present
if ! command -v git &> /dev/null; then
    echo "Installing git..."
    apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
fi

# Clone source if not present (first run only)
if [ ! -f "$SOURCE_DIR/package.json" ]; then
    echo ">>> Cloning Open WebUI $OPENWEBUI_VERSION (first run, ~1-2 min)..."
    cd "$SOURCE_DIR"
    # Clone into the volume (don't rm -rf as it's a mounted volume)
    git clone --depth 1 --branch "$OPENWEBUI_VERSION" https://github.com/open-webui/open-webui.git .
    cd "$SOURCE_DIR"

    echo ">>> Installing npm dependencies (first run, ~2-3 min)..."
    # Use legacy-peer-deps to handle tiptap conflicts
    npm ci --legacy-peer-deps
    npm install --legacy-peer-deps y-protocols js-yaml

    # Mark as initialized
    touch "$INITIALIZED_MARKER"
    echo ">>> Initial setup complete!"
else
    echo ">>> Using cached source (fast start)"
    cd "$SOURCE_DIR"
fi

# Always apply patches (they may have changed)
echo ""
echo ">>> Applying frontend patches..."
if [ -d "$PATCHES_DIR" ] && [ "$(ls -A $PATCHES_DIR 2>/dev/null)" ]; then
    cp -rv "$PATCHES_DIR"/* "$SOURCE_DIR/" 2>/dev/null || true
    echo "    Frontend patches applied"
else
    echo "    No frontend patches found in $PATCHES_DIR"
fi

# Apply backend patches
echo ">>> Applying backend patches..."
if [ -d "$BACKEND_PATCHES_DIR" ] && [ "$(ls -A $BACKEND_PATCHES_DIR 2>/dev/null)" ]; then
    mkdir -p "$SOURCE_DIR/backend"
    cp -rv "$BACKEND_PATCHES_DIR"/* "$SOURCE_DIR/backend/" 2>/dev/null || true
    echo "    Backend patches applied"
else
    echo "    No backend patches found in $BACKEND_PATCHES_DIR"
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
    cd "$SOURCE_DIR"
    node src/scripts/generate-model-config.cjs || echo "    Warning: Failed to generate model config"
    echo "    Model capabilities generated"
else
    echo "    Skipping model config generation (files not found)"
fi

# Verify patches were applied
echo ""
echo ">>> Verifying patches..."
if grep -q "PATCHED_MARKER_v2" "$SOURCE_DIR/src/lib/utils/marked/extension.ts" 2>/dev/null; then
    echo "    extension.ts: OK"
else
    echo "    extension.ts: NOT FOUND (may not have patched file)"
fi

if grep -q "contentBlocks" "$SOURCE_DIR/src/lib/components/chat/Chat.svelte" 2>/dev/null; then
    echo "    Chat.svelte: OK"
else
    echo "    Chat.svelte: NOT FOUND"
fi

# Start Vite dev server
echo ""
echo "=== Starting Vite Dev Server ==="
echo "Frontend: http://localhost:5173 (mapped to host:3789)"
echo "Hot-reload: ENABLED"
echo ""
echo "NOTE: Backend is served by open-webui-backend container on port 8080"
echo "      API calls are proxied via vite.config.ts"
echo ""
echo "Edit files in src/patches/frontend/ and changes will apply instantly!"
echo ""

cd "$SOURCE_DIR"
exec npm run dev -- --host 0.0.0.0
