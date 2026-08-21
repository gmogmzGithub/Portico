#!/usr/bin/env bash

# Regression tests for the PORTICO-205 slim-script split:
#   - slim-openwebui-package-json.cjs mutates ONLY package.json
#     (scripts.build -> 'vite build'); every other file stays byte-identical
#   - slim-openwebui-frontend.cjs applies ONLY source rewrites and leaves
#     package.json byte-identical
#   - both fail loudly when their markers/inputs are missing
#   - the combined sequence reproduces the pre-split end state
#   - Dockerfile.open-webui-patched keeps the layer-cache contract ordering
#   - src/patches/frontend carries no npm-manifest files that would silently
#     re-enter the dependency layers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PKG_SCRIPT="$PROJECT_ROOT/src/scripts/slim-openwebui-package-json.cjs"
SRC_SCRIPT="$PROJECT_ROOT/src/scripts/slim-openwebui-frontend.cjs"
DOCKERFILE="$PROJECT_ROOT/Dockerfile.open-webui-patched"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required for this test"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fixture_root="$tmp_dir/build"

make_fixture() {
  rm -rf "$fixture_root"
  mkdir -p "$fixture_root"
  node - "$fixture_root" <<'EOF'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];

function write(relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

write('package.json', JSON.stringify({
  name: 'open-webui',
  version: '0.6.43',
  scripts: {
    build: 'npm run pyodide:fetch && vite build',
    dev: 'vite dev'
  }
}, null, 2) + '\n');

write('src/routes/+layout.svelte',
  "<script>\n" +
  "\timport PyodideWorker from '$lib/workers/pyodide.worker?worker';\n" +
  "\tconst executePythonAsWorker = async (id, code, cb) => {\n" +
  "\t\tconsole.log('worker body');\n" +
  "\t};\n" +
  "\n\tconst executeTool = async (data, cb) => {\n" +
  "\t\treturn null;\n" +
  "\t};\n" +
  "\tconst onEvent = (type, data, cb) => {\n" +
  "\t\t\tif (type === 'execute:python') {\n" +
  "\t\t\t\tconsole.log('execute:python', data);\n" +
  "\t\t\t\texecutePythonAsWorker(data.id, data.code, cb);\n" +
  "\t\t\t} else if (type === 'execute:tool') {\n" +
  "\t\t\t\texecuteTool(data, cb);\n" +
  "\t\t\t}\n" +
  "\t};\n" +
  "</script>\n");

write('src/routes/(app)/+layout.svelte',
  "<script>\n" +
  "\tconst checkLocalDBChats = async () => {\n" +
  "\t\tDB = await openDB('Chats', 1);\n" +
  "\t\tlocalDBChats = await DB.getAllFromIndex('chats', 'timestamp');\n" +
  "\t\t\tif (localDBChats.length === 0) {\n" +
  "\t\t\t\tawait deleteDB('Chats');\n" +
  "\t\t\t}\n" +
  "\t};\n" +
  "</script>\n");

write('src/lib/components/common/CodeEditor.svelte',
  "<script>\n" +
  "\timport { onMount, createEventDispatcher, getContext, tick, onDestroy } from 'svelte';\n" +
  "\timport PyodideWorker from '$lib/workers/pyodide.worker?worker';\n\n" +
  "\timport { user } from '$lib/stores';\n" +
  "\tlet pyodideWorkerInstance = null;\n" +
  "\tlet other = 1;\n" +
  "\n\texport const formatPythonCodeHandler = async () => {\n" +
  "\t\ttry {\n" +
  "\t\t\tconst res = await (\n" +
  "\t\t\t\t$user?.role === 'admin'\n" +
  "\t\t\t\t\t? formatPythonCode(localStorage.token, _value)\n" +
  "\t\t\t\t\t: formatPythonCodePyodide(_value)\n" +
  "\t\t\t).catch((error) => {\n" +
  "\t\t\t\treturn null;\n" +
  "\t\t\t});\n" +
  "\t\t} catch (e) {}\n" +
  "\t};\n" +
  "\n\tonDestroy(() => {\n" +
  "\t\tif (pyodideWorkerInstance) {\n" +
  "\t\t\tpyodideWorkerInstance.terminate();\n" +
  "\t\t}\n" +
  "\t});\n" +
  "</script>\n");

write('src/lib/components/admin/Settings/CodeExecution.svelte',
  "<script>\n" +
  "\tlet engines = ['pyodide', 'jupyter'];\n" +
  "</script>\n");
EOF
}

checksum_tree() {
  (cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s ' "$f"
    cksum < "$f"
  done)
}

# --- 1. package-json mutator: only package.json changes ----------------------

make_fixture
before_sources="$(checksum_tree "$fixture_root/src")"
node "$PKG_SCRIPT" "$fixture_root" || fail "package-json mutator should succeed on a valid fixture"

grep -Fq '"build": "vite build"' "$fixture_root/package.json" \
  || fail "package-json mutator should rewrite scripts.build to 'vite build'"
grep -Fq '"dev": "vite dev"' "$fixture_root/package.json" \
  || fail "package-json mutator should preserve unrelated scripts"

after_sources="$(checksum_tree "$fixture_root/src")"
[ "$before_sources" = "$after_sources" ] \
  || fail "package-json mutator must not touch any file except package.json"

# --- 2. source-rewrite slimmer: package.json stays byte-identical ------------

pkg_before="$(cksum < "$fixture_root/package.json")"
node "$SRC_SCRIPT" "$fixture_root" || fail "source slimmer should succeed on a valid fixture"
pkg_after="$(cksum < "$fixture_root/package.json")"
[ "$pkg_before" = "$pkg_after" ] \
  || fail "source slimmer must leave package.json byte-identical"

layout="$fixture_root/src/routes/+layout.svelte"
! grep -Fq "PyodideWorker" "$layout" \
  || fail "source slimmer should remove the PyodideWorker import from +layout.svelte"
! grep -Fq "const executePythonAsWorker" "$layout" \
  || fail "source slimmer should remove the executePythonAsWorker block"
grep -Fq "Code execution is disabled in this deployment" "$layout" \
  || fail "source slimmer should stub the execute:python handler"

app_layout="$fixture_root/src/routes/(app)/+layout.svelte"
grep -Fq "DB.close();" "$app_layout" \
  || fail "source slimmer should close an empty legacy chat database before deleting it"
grep -Fq "DB = null;" "$app_layout" \
  || fail "source slimmer should discard the closed legacy chat database handle"

editor="$fixture_root/src/lib/components/common/CodeEditor.svelte"
! grep -Fq "PyodideWorker" "$editor" \
  || fail "source slimmer should remove the PyodideWorker import from CodeEditor.svelte"
! grep -Fq "onDestroy" "$editor" \
  || fail "source slimmer should remove onDestroy usage from CodeEditor.svelte"
grep -Fq "const res = await formatPythonCode(localStorage.token, _value).catch((error) => {" "$editor" \
  || fail "source slimmer should simplify formatPythonCodeHandler"

settings="$fixture_root/src/lib/components/admin/Settings/CodeExecution.svelte"
grep -Fq "let engines = ['jupyter'];" "$settings" \
  || fail "source slimmer should drop the pyodide engine"

# --- 3. combined sequence reproduces the pre-split end state -----------------

grep -Fq '"build": "vite build"' "$fixture_root/package.json" \
  || fail "combined sequence should end with scripts.build='vite build'"
! grep -rFq "pyodide" "$fixture_root/src" \
  || fail "combined sequence should leave no pyodide references in sources"

# --- 4. loud failures ---------------------------------------------------------

make_fixture
node - "$fixture_root" <<'EOF'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
delete pkg.scripts;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
EOF
if node "$PKG_SCRIPT" "$fixture_root" 2>/dev/null; then
  fail "package-json mutator must fail when scripts.build is missing"
fi

make_fixture
printf '<script>no markers here</script>\n' > "$fixture_root/src/routes/+layout.svelte"
if node "$SRC_SCRIPT" "$fixture_root" 2>/dev/null; then
  fail "source slimmer must fail loudly when a rewrite marker is missing"
fi

# --- 5. Dockerfile layer-cache contract ordering ------------------------------

line_of() {
  grep -nF "$1" "$DOCKERFILE" | head -1 | cut -d: -f1
}

pkg_mutator_copy="$(line_of 'COPY src/scripts/slim-openwebui-package-json.cjs')"
npm_ci_line="$(line_of 'RUN NODE_OPTIONS="--max-old-space-size=4096" npm ci --legacy-peer-deps')"
catalog_copy="$(line_of 'COPY model_catalog.yaml /build/')"
patches_copy="$(line_of 'COPY src/patches/frontend/ /build/')"
build_run="$(line_of 'RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build')"

[ -n "$pkg_mutator_copy" ] && [ -n "$npm_ci_line" ] && [ -n "$catalog_copy" ] \
  && [ -n "$patches_copy" ] && [ -n "$build_run" ] \
  || fail "Dockerfile.open-webui-patched is missing an expected cache-contract instruction"

[ "$pkg_mutator_copy" -lt "$npm_ci_line" ] \
  || fail "package.json mutator must be copied before npm ci"
[ "$npm_ci_line" -lt "$catalog_copy" ] \
  || fail "model_catalog.yaml must be copied after the npm dependency layers"
[ "$npm_ci_line" -lt "$patches_copy" ] \
  || fail "src/patches/frontend must be copied after the npm dependency layers"
[ "$patches_copy" -lt "$build_run" ] \
  || fail "npm run build must follow the patched-frontend COPY"

# --- 6. no npm-manifest files may hide inside src/patches/frontend -----------

forbidden="$(find "$PROJECT_ROOT/src/patches/frontend" \
  \( -name package.json -o -name package-lock.json -o -name npm-shrinkwrap.json -o -name .npmrc \) \
  -not -path '*/node_modules/*' 2>/dev/null || true)"
[ -z "$forbidden" ] \
  || fail "src/patches/frontend must not contain npm manifest files (would silently bust/poison the dependency layers): $forbidden"

echo "PASS: openwebui slim split regression tests"
