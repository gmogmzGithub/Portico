#!/usr/bin/env bash

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$TEST_DIR/.." && pwd -P)"
RESET_SCRIPT="$PROJECT_ROOT/reset_portico_installation.sh"
ORIGINAL_PATH="$PATH"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/test-reset-portico.XXXXXX")"
# shellcheck source=tests/helpers/parallel-shell-tests.sh
source "$PROJECT_ROOT/tests/helpers/parallel-shell-tests.sh"

cleanup() {
    if [ "${portico_RESET_TEST_KEEP_TMP:-0}" = "1" ]; then
        printf 'Preserved test fixtures: %s\n' "$TMP_ROOT" >&2
        return 0
    fi
    rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

# Portable sha256 for fixture generation: the harness must not depend on
# macOS-only shasum (absent on the Linux CI runners).
sha256_of() {
    python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}

assert_exists() {
    [ -e "$1" ] || fail "$2 (missing: $1)"
}

assert_not_exists() {
    [ ! -e "$1" ] && [ ! -L "$1" ] || fail "$2 (unexpected: $1)"
}

assert_contains() {
    grep -Fq -- "$2" "$1" || fail "$3"
}

assert_not_contains() {
    ! grep -Fq -- "$2" "$1" || fail "$3"
}

make_executable() {
    chmod +x "$1"
}

create_release_zip() {
    local output="$1"
    local dmg_count="${2:-1}"
    python3 - "$output" "$dmg_count" <<'PY'
import sys
import zipfile

output, count = sys.argv[1], int(sys.argv[2])
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for index in range(count):
        suffix = "" if index == 0 else f"-{index + 1}"
        archive.writestr(
            f"artifacts/dmg/darwin-arm64/Portico{suffix}.dmg",
            f"fake-dmg-{index}\n",
        )
    archive.writestr("release-manifest.json", "{}\n")
PY
}

create_baseline_zip() {
    local output="$1"
    local root_name="$2"
    local marker="$3"
    python3 - "$output" "$root_name" "$marker" <<'PY'
import sys
import zipfile

output, root_name, marker = sys.argv[1:4]
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(f"{root_name}/", "")
    archive.writestr(f"{root_name}/baseline-marker.txt", marker + "\n")
    archive.writestr(f"__MACOSX/._{root_name}", "metadata\n")
PY
}

create_malicious_baseline_zip() {
    local output="$1"
    python3 - "$output" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("portico/../../escaped.txt", "unsafe\n")
PY
}

write_packages() {
    local scenario="$1"
    local package_name="$2"
    local build_id="$3"
    local checksum=""
    checksum="$(sha256_of "$scenario/release.zip")"
    python3 - "$scenario/packages.json" "$package_name" "$build_id" "$checksum" <<'PY'
import json
import sys

path, package_name, build_id, checksum = sys.argv[1:5]
payload = [{
    "name": package_name,
    "version": build_id,
    "filename": f"{package_name}-{build_id}.zip",
    "uploaded_at": "2026-07-21T12:00:00.000Z",
    "checksum_sha256": checksum,
    "tags_immutable": {"info": ["portico-update-ready-v1"]},
}]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
}

write_latest_selection_packages() {
    local scenario="$1"
    local package_name="$2"
    local checksum=""
    checksum="$(sha256_of "$scenario/release.zip")"
    python3 - "$scenario/packages.json" "$package_name" "$checksum" <<'PY'
import json
import sys

path, package_name, checksum = sys.argv[1:4]
payload = [
    {
        "name": package_name,
        "version": "99999999-ffffffff",
        "filename": f"{package_name}-99999999-ffffffff.zip",
        "uploaded_at": "2026-07-25T12:00:00.000Z",
        "checksum_sha256": checksum,
        "tags_immutable": {"info": ["portico-update-ready-v1"]},
    },
    {
        "name": package_name,
        "version": "07242026-eeeeeeee",
        "filename": f"{package_name}-07242026-eeeeeeee.zip",
        "uploaded_at": "2026-07-24T13:00:00.000Z",
        "checksum_sha256": checksum,
        "tags": {"info": ["portico-update-ready-v1"]},
        "tags_immutable": {"info": []},
    },
    {
        "name": package_name,
        "version": "07242026-cccccccc",
        "filename": "wrong-prefix-07242026-cccccccc.zip",
        "uploaded_at": "2026-07-24T12:00:00.000Z",
        "checksum_sha256": checksum,
        "tags_immutable": {"info": ["portico-update-ready-v1"]},
    },
    {
        "name": package_name,
        "version": "07232026-bbbbbbbb",
        "filename": f"{package_name}-07232026-bbbbbbbb.zip",
        "uploaded_at": "2026-07-23T12:00:00.000Z",
        "checksum_sha256": "",
        "tags_immutable": {"info": ["portico-update-ready-v1"]},
    },
    {
        "name": package_name,
        "version": "07222026-dddddddd",
        "uploaded_at": "2026-07-22T12:00:00.000Z",
        "checksum_sha256": checksum,
        "tags_immutable": {"info": ["portico-update-ready-v1"]},
    },
    {
        "name": package_name,
        "version": "07212026-aaaaaaaa",
        "filename": f"{package_name}-07212026-aaaaaaaa.zip",
        "uploaded_at": "2026-07-21T12:00:00.000Z",
        "checksum_sha256": checksum,
        "tags_immutable": {"info": ["portico-update-ready-v1"]},
    },
]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
}

write_bridge_only_packages() {
    local scenario="$1"
    local package_name="$2"
    local checksum=""
    checksum="$(sha256_of "$scenario/release.zip")"
    python3 - "$scenario/packages.json" "$package_name" "$checksum" <<'PY'
import json
import sys

path, package_name, checksum = sys.argv[1:4]
with open(path, "w", encoding="utf-8") as handle:
    json.dump([{
        "name": package_name,
        "version": "99999999-ffffffff",
        "filename": f"{package_name}-99999999-ffffffff.zip",
        "uploaded_at": "2026-07-25T12:00:00.000Z",
        "checksum_sha256": checksum,
        "tags_immutable": {"info": ["portico-update-ready-v1"]},
    }], handle)
PY
}

write_fake_commands() {
    local scenario="$1"
    local fake_bin="$scenario/fake-bin"
    mkdir -p "$fake_bin"

    cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

output=""
url=""
write_status=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o|--output)
            output="$2"
            shift 2
            ;;
        -w)
            write_status=true
            shift 2
            ;;
        -H|--retry|--retry-delay)
            shift 2
            ;;
        -s|-S|-sS|-f|-L|-fL)
            shift
            ;;
        *)
            url="$1"
            shift
            ;;
    esac
done

printf '%s\n' "$url" >>"$FAKE_CURL_LOG"
if [[ "$url" == *"/packages/"* ]]; then
    cp "$FAKE_PACKAGES_JSON" "$output"
    if [ "$write_status" = true ]; then
        printf '%s' "${FAKE_LOOKUP_STATUS:-200}"
    fi
    exit "${FAKE_LOOKUP_EXIT:-0}"
fi

if [ "${FAKE_DOWNLOAD_FAIL:-0}" = "1" ]; then
    printf 'download failed for %s using %s\n' "$url" "${CLOUDSMITH_API_KEY:-missing}" >&2
    exit 22
fi
cp "$FAKE_RELEASE_ZIP" "$output"
SH

    cat >"$fake_bin/hdiutil" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_HDIUTIL_LOG"
case "${1:-}" in
    verify)
        exit "${FAKE_VERIFY_EXIT:-0}"
        ;;
    attach)
        [ "${FAKE_ATTACH_EXIT:-0}" = "0" ] || exit "$FAKE_ATTACH_EXIT"
        cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>system-entities</key><array><dict><key>mount-point</key><string>${FAKE_MOUNT_POINT}</string></dict></array></dict></plist>
EOF
        ;;
    *) exit 97 ;;
esac
SH

    cat >"$fake_bin/open" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_OPEN_LOG"
if [ "${1:-}" = "$FAKE_APP_PATH" ]; then
    [ "${FAKE_OPEN_APP_FAIL:-0}" = "0" ] || exit 1
    touch "$FAKE_STATE_DIR/app-resumed"
fi
SH

    cat >"$fake_bin/osascript" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_OSASCRIPT_LOG"
touch "$FAKE_STATE_DIR/app-quit"
SH

    cat >"$fake_bin/pgrep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if { [ "${FAKE_APP_ACTIVE:-0}" = "1" ] && [ ! -f "$FAKE_STATE_DIR/app-quit" ]; } \
    || [ -f "$FAKE_STATE_DIR/app-resumed" ]; then
    printf '%s\n' 424242
    exit 0
fi
exit 1
SH

    cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "${1:-}" in
    info)
        [ "${FAKE_DOCKER_DOWN:-0}" = "0" ]
        ;;
    ps)
        if [ "${FAKE_DOCKER_ACTIVE:-1}" = "1" ] && [ ! -f "$FAKE_STATE_DIR/docker-stopped" ]; then
            printf '%s\n' fake-portico-container
        fi
        ;;
    stop)
        [ "${FAKE_DOCKER_STOP_FAIL:-0}" = "0" ] || exit 1
        touch "$FAKE_STATE_DIR/docker-stopped"
        ;;
    start)
        [ "${FAKE_DOCKER_START_FAIL:-0}" = "0" ] || exit 1
        rm -f "$FAKE_STATE_DIR/docker-stopped"
        ;;
    *) exit 96 ;;
esac
SH

    # shasum, mkbom, and ditto exist natively on macOS but not on the Linux CI
    # runners, and validate_runtime require_command's both. Fake them with
    # python3 (guaranteed by the same validate_runtime contract) so the suite
    # behaves identically on both platforms.
    cat >"$fake_bin/shasum" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "-a" ] && [ "${2:-}" = "256" ] || { echo "fake shasum: unsupported args: $*" >&2; exit 96; }
python3 - "$3" <<'PY'
import hashlib, sys
path = sys.argv[1]
digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
print(f"{digest}  {path}")
PY
SH

    cat >"$fake_bin/mkbom" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
input=""
output=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -s)
            shift
            ;;
        -i)
            input="$2"
            shift 2
            ;;
        *)
            output="$1"
            shift
            ;;
    esac
done
[ "${FAKE_MKBOM_FAIL:-0}" = "0" ] || exit 1
[ "$input" = "/dev/stdin" ] && [ -n "$output" ] \
    || { echo "fake mkbom: unsupported args" >&2; exit 96; }
while IFS= read -r path; do
    printf '%s\n' "$path"
done >"$output"
SH

    cat >"$fake_bin/ditto" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mode=""
bom=""
args=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        -x)
            mode="extract"
            shift
            ;;
        -c)
            mode="create"
            shift
            ;;
        --bom)
            bom="$2"
            shift 2
            ;;
        -k|--norsrc|--sequesterRsrc|--keepParent)
            shift
            ;;
        *)
            args+=("$1")
            shift
            ;;
    esac
done
[ "${#args[@]}" -eq 2 ] || { echo "fake ditto: unsupported args: $*" >&2; exit 96; }
[ -n "$mode" ] || { echo "fake ditto: missing mode: $*" >&2; exit 96; }
if [ "$mode" = "create" ] && [ "${FAKE_DITTO_CREATE_FAIL:-0}" = "1" ]; then
    exit 1
fi
python3 - "$mode" "${args[0]}" "${args[1]}" "$bom" <<'PY'
import os
import stat
import sys
import zipfile
from pathlib import Path

mode, source, destination, bom = sys.argv[1:5]
if mode == "extract":
    with zipfile.ZipFile(source) as archive:
        for info in archive.infolist():
            target = Path(destination) / info.filename
            file_mode = (info.external_attr >> 16) & 0xFFFF
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            elif stat.S_IFMT(file_mode) == stat.S_IFLNK:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(archive.read(info).decode("utf-8"), target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source_handle, open(target, "wb") as target_handle:
                    target_handle.write(source_handle.read())
    raise SystemExit(0)

source_path = Path(source)
root_name = source_path.name
allowed = None
if bom:
    with open(bom, encoding="utf-8") as handle:
        allowed = {line.rstrip("\n") for line in handle}


def is_allowed(path):
    if allowed is None:
        return True
    relative = path.relative_to(source_path)
    key = "." if not relative.parts else "./" + relative.as_posix()
    return key in allowed


with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    root_info = zipfile.ZipInfo(root_name + "/")
    root_info.create_system = 3
    root_info.external_attr = (stat.S_IFDIR | 0o700) << 16
    archive.writestr(root_info, b"")
    for directory, dirnames, filenames in os.walk(source, followlinks=False):
        for name in list(dirnames):
            path = Path(directory) / name
            if not is_allowed(path):
                dirnames.remove(name)
                continue
            if path.is_symlink():
                relative = Path(root_name) / path.relative_to(source_path)
                info = zipfile.ZipInfo(relative.as_posix())
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.readlink(path).encode("utf-8"))
                dirnames.remove(name)
            else:
                relative = Path(root_name) / path.relative_to(source_path)
                info = zipfile.ZipInfo(relative.as_posix() + "/")
                info.create_system = 3
                info.external_attr = (stat.S_IFDIR | 0o700) << 16
                archive.writestr(info, b"")
        for name in filenames:
            path = Path(directory) / name
            if not is_allowed(path):
                continue
            relative = Path(root_name) / path.relative_to(source_path)
            if path.is_symlink():
                info = zipfile.ZipInfo(relative.as_posix())
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.readlink(path).encode("utf-8"))
            else:
                archive.write(path, relative.as_posix())
PY
SH

    if [ "$(uname -s)" = "Darwin" ]; then
        cat >"$fake_bin/shasum" <<'SH'
#!/usr/bin/env bash
exec /usr/bin/shasum "$@"
SH
        cat >"$fake_bin/mkbom" <<'SH'
#!/usr/bin/env bash
[ "${FAKE_MKBOM_FAIL:-0}" = "0" ] || exit 1
exec /usr/bin/mkbom "$@"
SH
        cat >"$fake_bin/ditto" <<'SH'
#!/usr/bin/env bash
if [ "${FAKE_DITTO_CREATE_FAIL:-0}" = "1" ]; then
    for argument in "$@"; do
        [ "$argument" = "-c" ] && exit 1
    done
fi
exec /usr/bin/ditto "$@"
SH
    fi

    chmod +x "$fake_bin/curl" "$fake_bin/hdiutil" "$fake_bin/open" \
        "$fake_bin/osascript" "$fake_bin/pgrep" "$fake_bin/docker" \
        "$fake_bin/shasum" "$fake_bin/mkbom" "$fake_bin/ditto"
}

write_fake_validator() {
    local scenario="$1"
    cat >"$scenario/fake-validator.py" <<'PY'
import os
import sys

with open(os.environ["FAKE_VALIDATOR_LOG"], "a", encoding="utf-8") as handle:
    handle.write(" ".join(sys.argv[1:]) + "\n")
if os.environ.get("FAKE_VALIDATOR_FAIL") == "1":
    print("Error: manifest buildNumber does not match filename/build identity", file=sys.stderr)
    raise SystemExit(1)
if os.environ.get("FAKE_VALIDATOR_MISSING_OOTB") == "1":
    allow_missing = "--allow-missing-ootb-marketplace-assets" in sys.argv[1:]
    if not allow_missing:
        if os.environ.get("FAKE_VALIDATOR_MISSING_OOTB_ASSET") == "skills":
            print(
                "Error: payload is missing the OOTB marketplace skills: "
                "managed-root/skills-marketplace-ootb/",
                file=sys.stderr,
            )
        else:
            print(
                "Error: payload is missing the OOTB marketplace config: "
                "managed-root/marketplaces-ootb.json",
                file=sys.stderr,
            )
        raise SystemExit(1)
    if os.environ.get("FAKE_VALIDATOR_FAIL_AFTER_OOTB") == "1":
        print("Error: payload is missing the darwin-arm64 app bundle", file=sys.stderr)
        raise SystemExit(1)
PY
}

setup_scenario() {
    local name="$1"
    local scenario="$TMP_ROOT/$name"
    local home="$scenario/home"

    mkdir -p \
        "$scenario/tmp" \
        "$scenario/state" \
        "$home/portico/portico-managed" \
        "$home/Library/Application Support/portico" \
        "$home/Library/Application Support/Portico Local Qualification" \
        "$home/Applications/Portico.app" \
        "$home/unrelated"
    printf 'current-managed\n' >"$home/portico/portico-managed/current.txt"
    printf 'current-app-support\n' >"$home/Library/Application Support/portico/current.txt"
    printf 'current-qualification\n' >"$home/Library/Application Support/Portico Local Qualification/current.txt"
    printf 'current-app\n' >"$home/Applications/Portico.app/current.txt"
    printf 'preserve-me\n' >"$home/unrelated/marker.txt"

    if [ -n "${RESET_SHARED_FIXTURE_ROOT:-}" ]; then
        cp "$RESET_SHARED_FIXTURE_ROOT/release.zip" "$scenario/release.zip"
        ln -s "$RESET_SHARED_FIXTURE_ROOT/fake-bin" "$scenario/fake-bin"
        ln -s "$RESET_SHARED_FIXTURE_ROOT/fake-validator.py" "$scenario/fake-validator.py"
    else
        create_release_zip "$scenario/release.zip" 1
        write_fake_commands "$scenario"
        write_fake_validator "$scenario"
    fi
    : >"$scenario/curl.log"
    : >"$scenario/docker.log"
    : >"$scenario/hdiutil.log"
    : >"$scenario/open.log"
    : >"$scenario/osascript.log"
    : >"$scenario/validator.log"
    : >"$scenario/keychain.log"
    printf '%s\n' "$scenario"
}

run_script() {
    local scenario="$1"
    local input="$2"
    local output_file="$3"
    shift 3
    local api_secret="API-SECRET-DO-NOT-PRINT"
    local entitlement_secret="ENTITLEMENT-SECRET-DO-NOT-PRINT"
    local status=0

    if [ "${FAKE_EMPTY_CLOUDSMITH_CREDENTIALS:-0}" = "1" ]; then
        api_secret=""
        entitlement_secret=""
    fi

    set +e
    printf '%b' "$input" | env -i \
        HOME="$scenario/home" \
        PATH="$scenario/fake-bin:$ORIGINAL_PATH" \
        TMPDIR="$scenario/tmp" \
        CLOUDSMITH_OWNER="portico" \
        CLOUDSMITH_REPO="portico" \
        CLOUDSMITH_API_BASE="https://api.test.invalid/v1" \
        CLOUDSMITH_DL_BASE="https://download.test.invalid" \
        CLOUDSMITH_API_KEY="$api_secret" \
        CLOUDSMITH_ENTITLEMENT_TOKEN="$entitlement_secret" \
        portico_RESET_TEST_MODE=1 \
        portico_RESET_TEST_APP_PATH="$scenario/home/Applications/Portico.app" \
        portico_RESET_TEST_PAYLOAD_VALIDATOR="$scenario/fake-validator.py" \
        portico_RESET_TEST_KEYCHAIN_LOG="$scenario/keychain.log" \
        portico_RESET_TEST_RELEASE_CACHE_DIR="${portico_RESET_TEST_RELEASE_CACHE_DIR:-}" \
        portico_RESET_TEST_AVAILABLE_BYTES="${portico_RESET_TEST_AVAILABLE_BYTES:-}" \
        portico_RESET_TEST_CAPTURE_TIMESTAMP="${portico_RESET_TEST_CAPTURE_TIMESTAMP:-}" \
        portico_RESET_TEST_CAPTURE_CREATED_AT="${portico_RESET_TEST_CAPTURE_CREATED_AT:-}" \
        FAKE_PACKAGES_JSON="$scenario/packages.json" \
        FAKE_RELEASE_ZIP="$scenario/release.zip" \
        FAKE_CURL_LOG="$scenario/curl.log" \
        FAKE_DOCKER_LOG="$scenario/docker.log" \
        FAKE_HDIUTIL_LOG="$scenario/hdiutil.log" \
        FAKE_OPEN_LOG="$scenario/open.log" \
        FAKE_OSASCRIPT_LOG="$scenario/osascript.log" \
        FAKE_VALIDATOR_LOG="$scenario/validator.log" \
        FAKE_STATE_DIR="$scenario/state" \
        FAKE_APP_PATH="$scenario/home/Applications/Portico.app" \
        FAKE_MOUNT_POINT="/Volumes/Portico Test" \
        FAKE_APP_ACTIVE="${FAKE_APP_ACTIVE:-0}" \
        FAKE_OPEN_APP_FAIL="${FAKE_OPEN_APP_FAIL:-0}" \
        FAKE_DOCKER_ACTIVE="${FAKE_DOCKER_ACTIVE:-1}" \
        FAKE_DOCKER_DOWN="${FAKE_DOCKER_DOWN:-0}" \
        FAKE_DOCKER_STOP_FAIL="${FAKE_DOCKER_STOP_FAIL:-0}" \
        FAKE_DOCKER_START_FAIL="${FAKE_DOCKER_START_FAIL:-0}" \
        FAKE_MKBOM_FAIL="${FAKE_MKBOM_FAIL:-0}" \
        FAKE_DITTO_CREATE_FAIL="${FAKE_DITTO_CREATE_FAIL:-0}" \
        FAKE_LOOKUP_STATUS="${FAKE_LOOKUP_STATUS:-200}" \
        FAKE_LOOKUP_EXIT="${FAKE_LOOKUP_EXIT:-0}" \
        FAKE_DOWNLOAD_FAIL="${FAKE_DOWNLOAD_FAIL:-0}" \
        FAKE_VERIFY_EXIT="${FAKE_VERIFY_EXIT:-0}" \
        FAKE_ATTACH_EXIT="${FAKE_ATTACH_EXIT:-0}" \
        FAKE_VALIDATOR_FAIL="${FAKE_VALIDATOR_FAIL:-0}" \
        FAKE_VALIDATOR_MISSING_OOTB="${FAKE_VALIDATOR_MISSING_OOTB:-0}" \
        FAKE_VALIDATOR_MISSING_OOTB_ASSET="${FAKE_VALIDATOR_MISSING_OOTB_ASSET:-config}" \
        FAKE_VALIDATOR_FAIL_AFTER_OOTB="${FAKE_VALIDATOR_FAIL_AFTER_OOTB:-0}" \
        /bin/bash "$RESET_SCRIPT" "$@" >"$output_file" 2>&1
    status=$?
    set -e
    return "$status"
}

run_reset() {
    local scenario="$1"
    local input="$2"
    local output_file="$3"
    run_script "$scenario" "1\n$input" "$output_file"
}

run_capture() {
    local scenario="$1"
    local input="$2"
    local output_file="$3"
    run_script "$scenario" "$input" "$output_file" --capture-baseline
}

assert_current_installation_untouched() {
    local scenario="$1"
    assert_exists "$scenario/home/portico/portico-managed/current.txt" "managed runtime changed before validation completed"
    assert_exists "$scenario/home/Library/Application Support/portico/current.txt" "app support changed before validation completed"
    assert_exists "$scenario/home/Library/Application Support/Portico Local Qualification/current.txt" "qualification data changed before validation completed"
    assert_exists "$scenario/home/Applications/Portico.app/current.txt" "installed app changed before validation completed"
}

test_help() {
    local output="$TMP_ROOT/help.out"
    /bin/bash "$RESET_SCRIPT" --help >"$output"
    assert_contains "$output" "There is deliberately no noninteractive confirmation bypass" "help omits confirmation contract"
    assert_contains "$output" "/Applications/Portico.app" "help omits canonical application target"
    assert_contains "$output" "independently offer to clear PORTICO-owned Keychain passwords" "help makes Keychain cleanup dependent on a fresh-disk reset"
    assert_contains "$output" "every other validation error still aborts" "help omits the narrow missing-OOTB exception"
    assert_contains "$output" "--capture-baseline" "help omits the baseline-capture shortcut"
    assert_contains "$output" "Portico Baselines" "help omits the private baseline store"
    assert_contains "$output" "Release Downloads" "help omits the persistent release cache"
    assert_contains "$output" "Existing matching ZIPs" "help omits reuse of prior Downloads workspaces"
    assert_contains "$output" "managed-node-mcp-package-acquisition" \
        "help omits generated acquisition scratch exclusion"
    assert_contains "$output" "managed-node-mcp-packages remain captured" \
        "help omits durable managed-package capture"
    assert_contains "$output" "never capture or clear Keychain state" "help omits the capture Keychain boundary"
}

test_capture_action_cancellation() {
    local scenario
    scenario="$(setup_scenario capture-cancel)"
    run_script "$scenario" '2\nCancelled baseline\nnot-capture\n' "$scenario/output" \
        || fail "capture cancellation should exit successfully"
    assert_current_installation_untouched "$scenario"
    assert_contains "$scenario/output" "2) Capture baseline" "normal invocation omitted the capture action"
    assert_contains "$scenario/output" "Baseline capture cancelled" "capture cancellation was not reported"
    assert_not_exists "$scenario/home/Library/Application Support/Portico Baselines" \
        "capture cancellation created the baseline store"
    assert_not_exists "$scenario/home/Library/Caches/Portico/Release Downloads" \
        "capture mode created the release cache"
    [ ! -s "$scenario/docker.log" ] || fail "capture cancellation touched Docker"
    [ ! -s "$scenario/curl.log" ] || fail "capture cancellation contacted Cloudsmith"
    [ ! -s "$scenario/keychain.log" ] || fail "capture cancellation touched Keychain"
}

test_capture_baseline_set() {
    local scenario baseline_store baseline_set managed_root
    scenario="$(setup_scenario capture-success)"
    baseline_store="$scenario/home/Library/Application Support/Portico Baselines"
    managed_root="$scenario/home/portico/portico-managed"
    mkdir -p \
        "$managed_root/electron-app" \
        "$managed_root/open-webui-data/managed-node-mcp-package-acquisition/chrome-devtools/tmp/bin" \
        "$managed_root/open-webui-data/managed-node-mcp-packages/chrome-devtools/package"
    printf '%s\n' \
        '{"buildNumber":"07072026-4d073bb9","channel":"portico_beta"}' \
        >"$managed_root/electron-app/build-info.json"
    printf 'generated scratch\n' \
        >"$managed_root/open-webui-data/managed-node-mcp-package-acquisition/chrome-devtools/cache.txt"
    ln -s /opt/homebrew/bin/node \
        "$managed_root/open-webui-data/managed-node-mcp-package-acquisition/chrome-devtools/tmp/bin/node"
    printf 'durable managed package\n' \
        >"$managed_root/open-webui-data/managed-node-mcp-packages/chrome-devtools/package/package.json"
    ln -s current.txt "$managed_root/current-link"

    FAKE_EMPTY_CLOUDSMITH_CREDENTIALS=1 \
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-120000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T16:00:00Z \
        run_capture "$scenario" 'bad/name\nBeta Baseline\nCAPTURE\n' "$scenario/output" \
        || fail "three-folder baseline capture failed"

    baseline_set="$baseline_store/20260721-120000-beta-baseline"
    assert_exists "$baseline_set/manifest.json" "capture manifest was not published"
    assert_exists "$baseline_set/managed.zip" "managed runtime was not captured"
    assert_exists "$baseline_set/application-support.zip" "application data was not captured"
    assert_exists "$baseline_set/local-qualification.zip" "qualification data was not captured"
    assert_current_installation_untouched "$scenario"
    assert_contains "$scenario/output" "Use a 1-80 character name" "unsafe capture label was not rejected"
    assert_contains "$scenario/output" "managed-node-mcp-package-acquisition" \
        "capture summary omitted the generated scratch exclusion"
    assert_contains "$scenario/output" "regenerated automatically" \
        "capture summary did not explain the excluded scratch policy"
    assert_contains "$scenario/docker.log" "stop fake-portico-container" "capture did not stop the running PORTICO container"
    assert_contains "$scenario/docker.log" "start fake-portico-container" "capture did not restore the running PORTICO container"
    [ ! -s "$scenario/curl.log" ] || fail "capture contacted Cloudsmith"
    [ ! -s "$scenario/hdiutil.log" ] || fail "capture touched a release DMG"
    [ ! -s "$scenario/keychain.log" ] || fail "capture touched Keychain state"

    python3 - "$baseline_store" "$baseline_set" <<'PY'
import hashlib
import json
import os
import stat
import sys
import zipfile

store, baseline = sys.argv[1:3]
assert stat.S_IMODE(os.stat(store).st_mode) == 0o700
assert stat.S_IMODE(os.stat(baseline).st_mode) == 0o700
with open(os.path.join(baseline, "manifest.json"), encoding="utf-8") as handle:
    manifest = json.load(handle)
assert manifest["schema_version"] == 1
assert manifest["id"] == "20260721-120000-beta-baseline"
assert manifest["label"] == "Beta Baseline"
assert manifest["created_at"] == "2026-07-21T16:00:00Z"
assert manifest["source_build"] == {
    "build_number": "07072026-4d073bb9",
    "channel": "portico_beta",
}
for folder_id, archive_name, root_name in (
    ("managed", "managed.zip", "portico-managed"),
    ("app_support", "application-support.zip", "portico"),
    ("qualification", "local-qualification.zip", "Portico Local Qualification"),
):
    path = os.path.join(baseline, archive_name)
    assert manifest["folders"][folder_id]["present"] is True
    assert manifest["folders"][folder_id]["sha256"] == hashlib.sha256(open(path, "rb").read()).hexdigest()
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    with zipfile.ZipFile(path) as archive:
        assert any(name.rstrip("/") == root_name for name in archive.namelist())
        if folder_id == "managed":
            names = archive.namelist()
            assert not any("managed-node-mcp-package-acquisition" in name for name in names)
            durable = (
                "portico-managed/open-webui-data/managed-node-mcp-packages/"
                "chrome-devtools/package/package.json"
            )
            assert durable in names
            link = archive.getinfo("portico-managed/current-link")
            assert stat.S_IFMT((link.external_attr >> 16) & 0xFFFF) == stat.S_IFLNK
            assert archive.read(link).decode("utf-8") == "current.txt"
assert stat.S_IMODE(os.stat(os.path.join(baseline, "manifest.json")).st_mode) == 0o600
PY

    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-120000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T16:00:01Z \
        run_capture "$scenario" 'Beta Baseline\nCAPTURE\n' "$scenario/second-output" \
        || fail "repeat baseline capture failed"
    assert_exists "$baseline_store/20260721-120000-beta-baseline-2/manifest.json" \
        "repeat capture did not allocate a unique timestamped baseline ID"

}

test_capture_runtime_resume() {
    local scenario
    scenario="$(setup_scenario capture-app-resume)"
    FAKE_APP_ACTIVE=1 \
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-120100 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T16:01:00Z \
        run_capture "$scenario" 'Running App\nCAPTURE\n' "$scenario/output" \
        || fail "capture did not resume a previously running app"
    assert_contains "$scenario/osascript.log" "com.portico.ai-chat" "capture did not quit the running app"
    assert_contains "$scenario/open.log" "$scenario/home/Applications/Portico.app" \
        "capture did not relaunch the previously running app"
}

test_capture_absent_folder_and_restore() {
    local scenario baseline_set managed_root
    scenario="$(setup_scenario capture-absent-qualification)"
    managed_root="$scenario/home/portico/portico-managed"
    rm -rf -- "$scenario/home/Library/Application Support/Portico Local Qualification"
    mkdir -p \
        "$managed_root/open-webui-data/managed-node-mcp-package-acquisition/work/demo/tmp/bin" \
        "$managed_root/open-webui-data/managed-node-mcp-packages/demo/package"
    ln -s /usr/local/bin/node \
        "$managed_root/open-webui-data/managed-node-mcp-package-acquisition/work/demo/tmp/bin/node"
    printf 'durable package marker\n' \
        >"$managed_root/open-webui-data/managed-node-mcp-packages/demo/package/marker.txt"
    ln -s current.txt "$managed_root/restored-current-link"

    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-130000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T17:00:00Z \
        run_capture "$scenario" 'No Qualification\nCAPTURE\n' "$scenario/capture-output" \
        || fail "capture with an absent qualification folder failed"
    baseline_set="$scenario/home/Library/Application Support/Portico Baselines/20260721-130000-no-qualification"
    assert_not_exists "$baseline_set/local-qualification.zip" "absent qualification folder produced an archive"
    python3 - "$baseline_set/manifest.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
assert manifest["folders"]["qualification"] == {"present": False, "sha256": None}
PY

    mkdir -p "$scenario/home/Library/Application Support/Portico Local Qualification"
    printf 'must-be-removed\n' >"$scenario/home/Library/Application Support/Portico Local Qualification/current.txt"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'y\nn\n2\nRESET\n' "$scenario/reset-output" \
        || fail "captured baseline with absent qualification data did not restore"
    assert_contains "$scenario/home/portico/portico-managed/current.txt" \
        "current-managed" "managed folder was not restored from the selected set"
    assert_contains \
        "$scenario/home/portico/portico-managed/open-webui-data/managed-node-mcp-packages/demo/package/marker.txt" \
        "durable package marker" "durable managed package was not restored"
    assert_not_exists \
        "$scenario/home/portico/portico-managed/open-webui-data/managed-node-mcp-package-acquisition" \
        "generated acquisition scratch was restored from the baseline"
    [ -L "$scenario/home/portico/portico-managed/restored-current-link" ] \
        || fail "safe internal symlink was not restored as a symlink"
    [ "$(readlink "$scenario/home/portico/portico-managed/restored-current-link")" = "current.txt" ] \
        || fail "safe internal symlink target changed during restore"
    assert_contains "$scenario/home/Library/Application Support/portico/current.txt" \
        "current-app-support" "application folder was not restored from the selected set"
    assert_not_exists "$scenario/home/Library/Application Support/Portico Local Qualification" \
        "qualification folder recorded absent was recreated"
    assert_exists "$baseline_set/manifest.json" "reset removed the saved baseline set"
}

test_multiple_baseline_selection_and_legacy_choice() {
    local scenario
    scenario="$(setup_scenario multiple-baselines)"

    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-140000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T18:00:00Z \
        run_capture "$scenario" 'Older Snapshot\nCAPTURE\n' "$scenario/capture-old" \
        || fail "older baseline capture failed"
    printf 'new-managed\n' >"$scenario/home/portico/portico-managed/current.txt"
    printf 'new-app-support\n' >"$scenario/home/Library/Application Support/portico/current.txt"
    printf 'new-qualification\n' >"$scenario/home/Library/Application Support/Portico Local Qualification/current.txt"
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260722-140000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-22T18:00:00Z \
        run_capture "$scenario" 'Newer Snapshot\nCAPTURE\n' "$scenario/capture-new" \
        || fail "newer baseline capture failed"
    create_baseline_zip \
        "$scenario/home/Library/Application Support/portico-beta-baseline.zip" \
        "portico" "legacy-app-support"
    create_baseline_zip \
        "$scenario/home/portico/portico-managed-beta-baseline.zip" \
        "portico-managed" "legacy-managed"

    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'y\n2\nn\n2\nRESET\n' "$scenario/output" \
        || fail "choosing a non-default captured baseline failed"
    assert_contains "$scenario/output" "1) Newer Snapshot" "newest baseline was not listed first"
    assert_contains "$scenario/output" "2) Older Snapshot" "older captured baseline was not listed second"
    assert_contains "$scenario/output" "3) Legacy beta baseline" "legacy beta baseline was not offered last"
    assert_contains "$scenario/home/portico/portico-managed/current.txt" \
        "current-managed" "selected older managed baseline was not restored"
    assert_contains "$scenario/home/Library/Application Support/portico/current.txt" \
        "current-app-support" "selected older application baseline was not restored"
    assert_contains "$scenario/home/Library/Application Support/Portico Local Qualification/current.txt" \
        "current-qualification" "selected older qualification baseline was not restored"
}

test_capture_rejects_symlinked_source() {
    local scenario
    scenario="$(setup_scenario capture-source-symlink)"
    mv "$scenario/home/portico/portico-managed" "$scenario/home/portico/managed-real"
    ln -s "$scenario/home/portico/managed-real" "$scenario/home/portico/portico-managed"
    if run_capture "$scenario" 'Unsafe Source\n' "$scenario/output"; then
        fail "capture accepted a symlinked source directory"
    fi
    [ ! -s "$scenario/docker.log" ] || fail "unsafe capture source reached runtime shutdown"
}

test_capture_rejects_external_nested_symlink() {
    local scenario
    scenario="$(setup_scenario capture-nested-external-symlink)"
    ln -s /opt/homebrew/bin/node \
        "$scenario/home/portico/portico-managed/external-node"
    if FAKE_APP_ACTIVE=1 run_capture "$scenario" 'Unsafe Nested Link\n' "$scenario/output"; then
        fail "capture accepted an external symlink outside generated scratch"
    fi
    assert_contains "$scenario/output" "Unsafe baseline symlink" \
        "nested external symlink failure omitted the offending link"
    assert_contains "$scenario/output" "/opt/homebrew/bin/node" \
        "nested external symlink failure omitted the target"
    [ ! -s "$scenario/docker.log" ] \
        || fail "nested external symlink reached runtime shutdown"
    [ ! -s "$scenario/osascript.log" ] \
        || fail "nested external symlink reached application shutdown"
}

test_capture_rejects_low_disk_space() {
    local scenario
    scenario="$(setup_scenario capture-low-space)"
    portico_RESET_TEST_AVAILABLE_BYTES=1
    if run_capture "$scenario" 'No Space\n' "$scenario/output"; then
        fail "capture ignored insufficient disk space"
    fi
    unset portico_RESET_TEST_AVAILABLE_BYTES
    assert_contains "$scenario/output" "Insufficient disk space" "low-space capture failure was not explained"
    [ ! -s "$scenario/docker.log" ] || fail "low-space capture reached runtime shutdown"
}

test_capture_handles_bom_failure() {
    local scenario baseline_store
    scenario="$(setup_scenario capture-bom-failure)"
    FAKE_APP_ACTIVE=1 \
    FAKE_MKBOM_FAIL=1 \
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-145000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T18:50:00Z
    if run_capture "$scenario" 'Broken BOM\nCAPTURE\n' "$scenario/output"; then
        fail "capture ignored a BOM generation failure"
    fi
    unset FAKE_APP_ACTIVE FAKE_MKBOM_FAIL \
        portico_RESET_TEST_CAPTURE_TIMESTAMP portico_RESET_TEST_CAPTURE_CREATED_AT
    baseline_store="$scenario/home/Library/Application Support/Portico Baselines"
    if [ -d "$baseline_store" ]; then
        [ -z "$(find "$baseline_store" -mindepth 1 -maxdepth 1 -print -quit)" ] \
            || fail "failed BOM capture left a partial baseline set"
    fi
    assert_contains "$scenario/output" "Failed to create managed baseline inclusion BOM" \
        "BOM generation failure was not explained"
    assert_contains "$scenario/open.log" "$scenario/home/Applications/Portico.app" \
        "BOM generation failure did not restore the previously running app"
}

test_capture_handles_archive_failure() {
    local scenario baseline_store
    scenario="$(setup_scenario capture-archive-failure)"
    FAKE_APP_ACTIVE=1 \
    FAKE_DITTO_CREATE_FAIL=1 \
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-150000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T19:00:00Z
    if run_capture "$scenario" 'Broken Archive\nCAPTURE\n' "$scenario/output"; then
        fail "capture ignored an archive creation failure"
    fi
    unset FAKE_APP_ACTIVE FAKE_DITTO_CREATE_FAIL \
        portico_RESET_TEST_CAPTURE_TIMESTAMP portico_RESET_TEST_CAPTURE_CREATED_AT
    baseline_store="$scenario/home/Library/Application Support/Portico Baselines"
    if [ -d "$baseline_store" ]; then
        [ -z "$(find "$baseline_store" -mindepth 1 -maxdepth 1 -print -quit)" ] \
            || fail "failed capture left a partial baseline set"
    fi
    assert_contains "$scenario/open.log" "$scenario/home/Applications/Portico.app" \
        "failed capture did not restore the previously running app"
}

test_capture_reports_runtime_resume_failure() {
    local scenario baseline_set
    scenario="$(setup_scenario capture-resume-failure)"
    FAKE_DOCKER_START_FAIL=1 \
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-160000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T20:00:00Z
    if run_capture "$scenario" 'Resume Failure\nCAPTURE\n' "$scenario/output"; then
        fail "capture reported success when runtime restoration failed"
    fi
    unset FAKE_DOCKER_START_FAIL \
        portico_RESET_TEST_CAPTURE_TIMESTAMP portico_RESET_TEST_CAPTURE_CREATED_AT
    baseline_set="$scenario/home/Library/Application Support/Portico Baselines/20260721-160000-resume-failure"
    assert_exists "$baseline_set/manifest.json" "runtime resume failure discarded a valid published baseline"
    assert_contains "$scenario/output" "Baseline was captured, but the prior runtime state could not be restored" \
        "runtime resume failure did not preserve the capture outcome"
}

test_catalog_ignores_malformed_baseline_set() {
    local scenario baseline_store
    scenario="$(setup_scenario malformed-baseline-set)"
    baseline_store="$scenario/home/Library/Application Support/Portico Baselines"
    mkdir -p "$baseline_store/20260721-170000-malformed"
    printf '{}\n' >"$baseline_store/20260721-170000-malformed/manifest.json"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'n\n2\nnope\n' "$scenario/output" \
        || fail "malformed catalog entry prevented a fresh-reset cancellation"
    assert_contains "$scenario/output" "ignoring invalid baseline set" "malformed baseline set was not reported"
    assert_contains "$scenario/output" "No saved baselines were found" "malformed baseline set was offered for restore"
}

test_reset_rejects_tampered_baseline_set() {
    local scenario baseline_set
    scenario="$(setup_scenario tampered-baseline-set)"
    portico_RESET_TEST_CAPTURE_TIMESTAMP=20260721-180000 \
    portico_RESET_TEST_CAPTURE_CREATED_AT=2026-07-21T22:00:00Z \
        run_capture "$scenario" 'Tamper Check\nCAPTURE\n' "$scenario/capture-output" \
        || fail "tamper fixture capture failed"
    baseline_set="$scenario/home/Library/Application Support/Portico Baselines/20260721-180000-tamper-check"
    printf 'tampered\n' >>"$baseline_set/managed.zip"
    : >"$scenario/docker.log"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    if run_reset "$scenario" 'y\nn\n2\nRESET\n' "$scenario/reset-output"; then
        fail "reset accepted a baseline archive with a mismatched checksum"
    fi
    assert_current_installation_untouched "$scenario"
    [ ! -s "$scenario/docker.log" ] || fail "tampered baseline reached runtime shutdown"
    assert_contains "$scenario/reset-output" "SHA-256 does not match" "tampered baseline failure was not explained"
}

test_capture_and_catalog_fail_closed() {
    local capture_fail_closed_functions=(
        test_capture_rejects_symlinked_source
        test_capture_rejects_external_nested_symlink
        test_capture_rejects_low_disk_space
        test_capture_handles_bom_failure
        test_capture_handles_archive_failure
        test_capture_reports_runtime_resume_failure
        test_catalog_ignores_malformed_baseline_set
        test_reset_rejects_tampered_baseline_set
    )
    run_shell_test_functions_parallel 8 "${capture_fail_closed_functions[@]}"
}

test_cancel_preserves_everything() {
    local scenario
    scenario="$(setup_scenario cancel)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'n\n2\nnope\n' "$scenario/output" || fail "cancellation should exit successfully"
    assert_current_installation_untouched "$scenario"
    assert_exists "$scenario/home/unrelated/marker.txt" "unrelated data was removed on cancellation"
    [ ! -s "$scenario/docker.log" ] || fail "cancellation touched Docker"
    [ ! -s "$scenario/keychain.log" ] || fail "cancellation touched Keychain"
    assert_not_exists "$scenario/home/Downloads/Portico Install" "cancellation created a Downloads workspace"
    assert_not_exists "$scenario/home/Library/Caches/Portico/Release Downloads" \
        "cancellation created the release cache"
}

test_channel_mapping() {
    local input="$1"
    local package="$2"
    local expected="$3"
    local scenario output
    scenario="$(setup_scenario "mapping-${expected}")"
    write_packages "$scenario" "$package" "07212026-aaaaaaaa"
    output="$scenario/output"
    run_reset "$scenario" "n\n${input}\nnope\n" "$output" || fail "channel mapping cancellation failed for $expected"
    assert_contains "$output" "Release channel:        $expected ($package)" "channel mapping was wrong for $expected"
}

test_stable_channel_mapping() {
    test_channel_mapping 1 portico stable
}

test_beta_channel_mapping() {
    test_channel_mapping 2 portico_beta beta
}

test_dev_channel_mapping() {
    test_channel_mapping 3 portico_dev dev
}

test_custom_slug_mapping() {
    local scenario
    scenario="$(setup_scenario mapping-custom-slug)"
    write_packages "$scenario" "portico_team-alpha" "07212026-aaaaaaaa"
    run_reset "$scenario" 'n\n4\ninvalid value!\nTeam-Alpha\nnope\n' "$scenario/output" \
        || fail "custom slug mapping cancellation failed"
    assert_contains "$scenario/output" "Release channel:        team-alpha (portico_team-alpha)" "custom slug did not map to the custom package"
    assert_contains "$scenario/output" "Invalid custom channel" "invalid custom slug was not rejected"

}

test_custom_package_mapping() {
    local scenario
    scenario="$(setup_scenario mapping-custom-package)"
    write_packages "$scenario" "portico_pre-beta-tmp" "07212026-aaaaaaaa"
    run_reset "$scenario" 'n\n4\nportico_pre-beta-tmp\nnope\n' "$scenario/output" \
        || fail "full custom package mapping cancellation failed"
    assert_contains "$scenario/output" "Release channel:        pre-beta-tmp (portico_pre-beta-tmp)" "full custom package name was not accepted"

}

test_latest_channel_selection() {
    local scenario
    scenario="$(setup_scenario latest-selection)"
    write_latest_selection_packages "$scenario" "portico_beta"
    run_reset "$scenario" 'n\n2\nnope\n' "$scenario/output" || fail "latest selection cancellation failed"
    assert_contains "$scenario/output" "Selected build:         07222026-dddddddd" "latest valid non-bridge package was not selected"
}

test_fresh_reset_downloads_stops_and_opens() {
    local scenario workspace
    scenario="$(setup_scenario fresh-success)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_APP_ACTIVE=1 run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output" \
        || fail "fresh reset failed"

    assert_not_exists "$scenario/home/portico/portico-managed" "managed runtime was not deleted"
    assert_not_exists "$scenario/home/Library/Application Support/portico" "application data was not deleted"
    assert_not_exists "$scenario/home/Library/Application Support/Portico Local Qualification" "qualification data was not deleted"
    assert_not_exists "$scenario/home/Applications/Portico.app" "installed app was not deleted"
    assert_exists "$scenario/home/unrelated/marker.txt" "unrelated home data was deleted"

    workspace="$scenario/home/Downloads/Portico Install/portico_beta-07212026-aaaaaaaa"
    assert_exists "$workspace/portico_beta-07212026-aaaaaaaa.zip" "downloaded release ZIP was not retained"
    assert_exists "$workspace/release/artifacts/dmg/darwin-arm64/Portico.dmg" "release payload was not extracted"
    assert_contains "$scenario/docker.log" "stop fake-portico-container" "PORTICO container was not stopped"
    assert_not_contains "$scenario/docker.log" " rm " "Docker containers were removed"
    assert_not_contains "$scenario/docker.log" " down" "Docker compose state was removed"
    assert_contains "$scenario/osascript.log" "com.portico.ai-chat" "running app was not asked to quit"
    assert_contains "$scenario/hdiutil.log" "verify" "DMG was not verified"
    assert_contains "$scenario/hdiutil.log" "attach -readonly -nobrowse -plist" "DMG was not mounted read-only"
    assert_contains "$scenario/open.log" "/Volumes/Portico Test" "mounted DMG volume was not opened"
    assert_not_contains "$scenario/output" "API-SECRET-DO-NOT-PRINT" "API key leaked to output"
    assert_not_contains "$scenario/output" "ENTITLEMENT-SECRET-DO-NOT-PRINT" "entitlement token leaked to output"
}

test_release_download_cache_reuse() {
    local scenario checksum cache_file download_count workspace_zip

    scenario="$(setup_scenario release-cache-hit)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/first-output" \
        || fail "initial cached-release reset failed"

    checksum="$(sha256_of "$scenario/release.zip")"
    cache_file="$scenario/home/Library/Caches/Portico/Release Downloads/$checksum.zip"
    assert_exists "$cache_file" "verified release was not persisted in the cache"
    python3 - "$cache_file" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
PY

    FAKE_DOWNLOAD_FAIL=1
    run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/second-output" \
        || fail "verified cache hit still attempted a release download"
    unset FAKE_DOWNLOAD_FAIL
    download_count="$(awk '/\/raw\/names\// { count++ } END { print count + 0 }' "$scenario/curl.log")"
    [ "$download_count" = "1" ] || fail "the same verified release was downloaded more than once"
    assert_contains "$scenario/second-output" \
        "Using cached portico_beta-07212026-aaaaaaaa.zip" \
        "cache reuse was not reported"
    assert_exists \
        "$scenario/home/Downloads/Portico Install/portico_beta-07212026-aaaaaaaa-2/release/artifacts/dmg/darwin-arm64/Portico.dmg" \
        "cached release was not validated and extracted into the new workspace"

    # A checksum mismatch in both the cache and retained workspace must force a
    # clean download rather than trusting either local copy.
    printf 'corrupt-cache\n' >"$cache_file"
    workspace_zip="$scenario/home/Downloads/Portico Install/portico_beta-07212026-aaaaaaaa/portico_beta-07212026-aaaaaaaa.zip"
    printf 'corrupt-workspace\n' >"$workspace_zip"
    workspace_zip="$scenario/home/Downloads/Portico Install/portico_beta-07212026-aaaaaaaa-2/portico_beta-07212026-aaaaaaaa.zip"
    printf 'corrupt-workspace\n' >"$workspace_zip"
    run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/third-output" \
        || fail "corrupt cache was not replaced by a fresh verified download"
    download_count="$(awk '/\/raw\/names\// { count++ } END { print count + 0 }' "$scenario/curl.log")"
    [ "$download_count" = "2" ] || fail "corrupt local releases did not cause exactly one replacement download"
    [ "$(sha256_of "$cache_file")" = "$checksum" ] || fail "replacement cache entry has the wrong checksum"
    assert_contains "$scenario/third-output" "Discarding a cached release" \
        "corrupt cache replacement was not reported"

}

test_release_download_cache_seed_existing() {
    local scenario download_count
    scenario="$(setup_scenario release-cache-seed-existing)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    mkdir -p "$scenario/home/Downloads/Portico Install/previous-run"
    cp "$scenario/release.zip" \
        "$scenario/home/Downloads/Portico Install/previous-run/portico_beta-07212026-aaaaaaaa.zip"
    FAKE_DOWNLOAD_FAIL=1
    run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output" \
        || fail "existing verified Downloads copy did not seed the release cache"
    unset FAKE_DOWNLOAD_FAIL
    download_count="$(awk '/\/raw\/names\// { count++ } END { print count + 0 }' "$scenario/curl.log")"
    [ "$download_count" = "0" ] || fail "existing verified Downloads copy was downloaded again"
    assert_contains "$scenario/output" "Found a verified copy" \
        "reuse of the existing Downloads copy was not reported"
}

test_restore_baselines_and_unique_workspace() {
    local scenario base workspace
    scenario="$(setup_scenario restore-success)"
    create_baseline_zip \
        "$scenario/home/Library/Application Support/portico-beta-baseline.zip" \
        "portico" "restored-app-support"
    create_baseline_zip \
        "$scenario/home/portico/portico-managed-beta-baseline.zip" \
        "portico-managed" "restored-managed"
    write_packages "$scenario" "portico" "07212026-aaaaaaaa"

    base="$scenario/home/Downloads/Portico Install"
    mkdir -p "$base/portico-07212026-aaaaaaaa"
    run_reset "$scenario" 'y\nn\n1\nRESET\n' "$scenario/output" || fail "baseline restore failed"

    assert_contains "$scenario/home/Library/Application Support/portico/baseline-marker.txt" \
        "restored-app-support" "app-support baseline was not restored"
    assert_contains "$scenario/home/portico/portico-managed/baseline-marker.txt" \
        "restored-managed" "managed baseline was not restored"
    assert_not_exists "$scenario/home/Library/Application Support/Portico Local Qualification" "qualification data survived baseline restore"
    assert_not_exists "$scenario/home/Applications/Portico.app" "installed app survived baseline restore"
    assert_not_exists "$scenario/home/Library/Application Support/__MACOSX" "AppleDouble metadata escaped into Application Support"
    assert_not_exists "$scenario/home/portico/__MACOSX" "AppleDouble metadata escaped into ~/portico"
    [ ! -s "$scenario/keychain.log" ] || fail "baseline restore unexpectedly cleared Keychain state"
    assert_contains "$scenario/output" "Qualification data:    absent in snapshot" \
        "legacy baseline did not disclose its missing qualification snapshot"
    assert_contains "$scenario/output" "Clear secure state:     false" "summary omitted preserved Keychain state during baseline restore"
    workspace="$base/portico-07212026-aaaaaaaa-2"
    assert_exists "$workspace/release/artifacts/dmg/darwin-arm64/Portico.dmg" "repeat download did not use a unique workspace"
}

test_missing_baselines_are_skipped() {
    local scenario
    scenario="$(setup_scenario missing-baselines)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output" || fail "missing baseline run failed"
    assert_not_exists "$scenario/home/portico/portico-managed" "missing managed baseline should leave a fresh path"
    assert_not_exists "$scenario/home/Library/Application Support/portico" "missing app-support baseline should leave a fresh path"
    assert_contains "$scenario/output" "No saved baselines were found; reset will use fresh disk state." "missing baseline state was not reported"
}

test_fresh_reset_keychain_cleanup() {
    local scenario
    scenario="$(setup_scenario keychain-clear)"
    write_packages "$scenario" "portico_dev" "07212026-aaaaaaaa"
    run_reset "$scenario" 'y\n3\nRESET\n' "$scenario/output" || fail "fresh reset with Keychain cleanup failed"
    assert_contains "$scenario/keychain.log" "portico_cleanup_legacy_oauth_certificates" "legacy OAuth certificates were not cleared"
    assert_contains "$scenario/keychain.log" "portico_cleanup_generic_passwords" "PORTICO generic passwords were not cleared"
    assert_contains "$scenario/keychain.log" "portico_remove_single_server_ssl_caches" "OAuth SSL caches were not cleared"

}

test_restored_reset_keychain_cleanup() {
    local scenario
    scenario="$(setup_scenario restore-and-keychain-clear)"
    create_baseline_zip \
        "$scenario/home/Library/Application Support/portico-beta-baseline.zip" \
        "portico" "restored-app-support"
    create_baseline_zip \
        "$scenario/home/portico/portico-managed-beta-baseline.zip" \
        "portico-managed" "restored-managed"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    run_reset "$scenario" 'y\ny\n2\nRESET\n' "$scenario/output" \
        || fail "baseline restore with independent Keychain cleanup failed"
    assert_contains "$scenario/home/Library/Application Support/portico/baseline-marker.txt" \
        "restored-app-support" "Keychain cleanup prevented app-support baseline restoration"
    assert_contains "$scenario/home/portico/portico-managed/baseline-marker.txt" \
        "restored-managed" "Keychain cleanup prevented managed baseline restoration"
    assert_contains "$scenario/keychain.log" "portico_cleanup_legacy_oauth_certificates" "baseline restore did not clear legacy OAuth certificates when requested"
    assert_contains "$scenario/keychain.log" "portico_cleanup_generic_passwords" "baseline restore did not clear PORTICO generic passwords when requested"
    assert_contains "$scenario/keychain.log" "portico_remove_single_server_ssl_caches" "baseline restore did not clear OAuth SSL caches when requested"
    assert_contains "$scenario/output" "Clear secure state:     true" "summary omitted requested Keychain cleanup during baseline restore"
}

test_missing_ootb_override_declined() {
    local scenario

    scenario="$(setup_scenario missing-ootb-declined)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_VALIDATOR_MISSING_OOTB=1
    if run_reset "$scenario" 'n\n2\nRESET\n\n' "$scenario/output"; then
        fail "missing OOTB validation override defaulted to acceptance"
    fi
    unset FAKE_VALIDATOR_MISSING_OOTB
    assert_current_installation_untouched "$scenario"
    assert_contains "$scenario/output" \
        "Ignore this missing OOTB marketplace validation error and continue? [y/N]:" \
        "missing OOTB validation did not request explicit approval"
    assert_not_contains "$scenario/validator.log" \
        "--allow-missing-ootb-marketplace-assets" \
        "declined OOTB override reran the validator with the exception"

}

test_missing_ootb_override_accepted() {
    local scenario
    scenario="$(setup_scenario missing-ootb-accepted)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_VALIDATOR_MISSING_OOTB=1
    run_reset "$scenario" 'n\n2\nRESET\ny\n' "$scenario/output" \
        || fail "explicit missing OOTB validation override did not continue"
    unset FAKE_VALIDATOR_MISSING_OOTB
    assert_not_exists \
        "$scenario/home/portico/portico-managed/current.txt" \
        "approved OOTB exception did not reach the reset"
    assert_contains "$scenario/validator.log" \
        "--allow-missing-ootb-marketplace-assets" \
        "approved OOTB exception did not rerun the canonical validator narrowly"

}

test_missing_ootb_skills_override_accepted() {
    local scenario
    scenario="$(setup_scenario missing-ootb-skills-accepted)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_VALIDATOR_MISSING_OOTB=1
    FAKE_VALIDATOR_MISSING_OOTB_ASSET=skills
    run_reset "$scenario" 'n\n2\nRESET\ny\n' "$scenario/output" \
        || fail "missing OOTB skills validation override did not continue"
    unset FAKE_VALIDATOR_MISSING_OOTB FAKE_VALIDATOR_MISSING_OOTB_ASSET

}

test_missing_ootb_override_rejects_other_errors() {
    local scenario
    scenario="$(setup_scenario missing-ootb-plus-other-error)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_VALIDATOR_MISSING_OOTB=1
    FAKE_VALIDATOR_FAIL_AFTER_OOTB=1
    if run_reset "$scenario" 'n\n2\nRESET\ny\n' "$scenario/output"; then
        fail "OOTB exception also bypassed a non-marketplace payload error"
    fi
    unset FAKE_VALIDATOR_MISSING_OOTB FAKE_VALIDATOR_FAIL_AFTER_OOTB
    assert_current_installation_untouched "$scenario"
    assert_contains "$scenario/output" \
        "payload is missing the darwin-arm64 app bundle" \
        "non-marketplace validation error was not surfaced after the OOTB exception"
    [ ! -s "$scenario/docker.log" ] \
        || fail "non-marketplace validation error reached runtime shutdown"
}

test_malicious_baseline_fails_before_mutation() {
    local scenario
    scenario="$(setup_scenario malicious-baseline)"
    create_malicious_baseline_zip "$scenario/home/Library/Application Support/portico-beta-baseline.zip"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    if run_reset "$scenario" 'y\nn\n2\nRESET\n' "$scenario/output"; then
        fail "malicious baseline was accepted"
    fi
    assert_current_installation_untouched "$scenario"
    [ ! -s "$scenario/docker.log" ] || fail "malicious baseline reached runtime shutdown"

}

test_checksum_failure_cleans_workspace() {
    local scenario downloads
    scenario="$(setup_scenario checksum-failure)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    python3 - "$scenario/packages.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
payload[0]["checksum_sha256"] = "0" * 64
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "checksum mismatch was accepted"
    fi
    assert_current_installation_untouched "$scenario"
    downloads="$scenario/home/Downloads/Portico Install"
    if [ -d "$downloads" ]; then
        [ -z "$(find "$downloads" -mindepth 1 -maxdepth 1 -print -quit)" ] \
            || fail "failed checksum left a partial download workspace"
    fi

}

test_validator_failure_fails_before_mutation() {
    local scenario
    scenario="$(setup_scenario validator-failure)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_VALIDATOR_FAIL=1
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "payload validator failure was ignored"
    fi
    unset FAKE_VALIDATOR_FAIL
    assert_current_installation_untouched "$scenario"
    assert_not_contains "$scenario/output" \
        "Ignore this missing OOTB marketplace validation error" \
        "generic payload validator failure offered the OOTB exception"

}

test_multiple_dmgs_fail_before_mutation() {
    local scenario
    scenario="$(setup_scenario multi-dmg)"
    create_release_zip "$scenario/release.zip" 2
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "payload with multiple arm64 DMGs was accepted"
    fi
    assert_current_installation_untouched "$scenario"

}

test_bridge_only_channel_fails_before_mutation() {
    local scenario
    scenario="$(setup_scenario bridge-only)"
    write_bridge_only_packages "$scenario" "portico_beta"
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "bridge-only channel was accepted"
    fi
    assert_current_installation_untouched "$scenario"
}

test_download_failure_redacts_and_preserves_state() {
    local scenario

    scenario="$(setup_scenario download-failure)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_DOWNLOAD_FAIL=1
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "download failure was ignored"
    fi
    unset FAKE_DOWNLOAD_FAIL
    assert_current_installation_untouched "$scenario"
    assert_not_contains "$scenario/output" "API-SECRET-DO-NOT-PRINT" "download failure leaked API key"
    assert_not_contains "$scenario/output" "ENTITLEMENT-SECRET-DO-NOT-PRINT" "download failure leaked entitlement token"

}

test_dmg_verify_failure_preserves_state() {
    local scenario
    scenario="$(setup_scenario dmg-verify-failure)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_VERIFY_EXIT=1
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "DMG verification failure was ignored"
    fi
    unset FAKE_VERIFY_EXIT
    assert_current_installation_untouched "$scenario"

}

test_docker_stop_failure_preserves_state() {
    local scenario
    scenario="$(setup_scenario docker-stop-failure)"
    write_packages "$scenario" "portico_beta" "07212026-aaaaaaaa"
    FAKE_DOCKER_STOP_FAIL=1
    if run_reset "$scenario" 'n\n2\nRESET\n' "$scenario/output"; then
        fail "Docker stop failure was ignored"
    fi
    unset FAKE_DOCKER_STOP_FAIL
    assert_current_installation_untouched "$scenario"
    assert_contains "$scenario/output" "no installation paths were deleted" "Docker failure lacked fail-closed diagnostic"
}

reset_test_functions=(
    test_release_download_cache_reuse
    test_capture_baseline_set
    test_multiple_baseline_selection_and_legacy_choice
    test_capture_absent_folder_and_restore
    test_fresh_reset_downloads_stops_and_opens
    test_restore_baselines_and_unique_workspace
    test_restored_reset_keychain_cleanup
    test_fresh_reset_keychain_cleanup
    test_missing_ootb_override_accepted
    test_missing_ootb_skills_override_accepted
    test_missing_ootb_override_rejects_other_errors
    test_missing_ootb_override_declined
    test_release_download_cache_seed_existing
    test_capture_runtime_resume
    test_checksum_failure_cleans_workspace
    test_validator_failure_fails_before_mutation
    test_multiple_dmgs_fail_before_mutation
    test_malicious_baseline_fails_before_mutation
    test_bridge_only_channel_fails_before_mutation
    test_download_failure_redacts_and_preserves_state
    test_dmg_verify_failure_preserves_state
    test_docker_stop_failure_preserves_state
    test_latest_channel_selection
    test_custom_slug_mapping
    test_custom_package_mapping
    test_stable_channel_mapping
    test_beta_channel_mapping
    test_dev_channel_mapping
    test_missing_baselines_are_skipped
    test_reset_rejects_tampered_baseline_set
    test_capture_reports_runtime_resume_failure
    test_capture_handles_archive_failure
    test_capture_handles_bom_failure
    test_capture_rejects_symlinked_source
    test_capture_rejects_external_nested_symlink
    test_capture_rejects_low_disk_space
    test_catalog_ignores_malformed_baseline_set
    test_cancel_preserves_everything
    test_capture_action_cancellation
    test_help
)
RESET_SHARED_FIXTURE_ROOT="$TMP_ROOT/shared-fixtures"
mkdir -p "$RESET_SHARED_FIXTURE_ROOT"
create_release_zip "$RESET_SHARED_FIXTURE_ROOT/release.zip" 1
write_fake_commands "$RESET_SHARED_FIXTURE_ROOT"
write_fake_validator "$RESET_SHARED_FIXTURE_ROOT"
run_shell_test_functions_parallel \
    "${RESET_TEST_CONCURRENCY:-10}" \
    "${reset_test_functions[@]}"

printf 'reset_portico_installation.sh tests passed\n'
