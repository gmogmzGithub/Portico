#!/usr/bin/env bash

set -euo pipefail
umask 077

EXPECTED_IDENTITY="${APPLE_CODESIGN_IDENTITY:-Developer ID Application: Portico, Inc. (AJDA86F3YP)}"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

[ "$#" -gt 0 ] || die "usage: with-apple-signing-key.sh <command> [args...]"
[ -n "${APPLE_CODESIGN_P12_BASE64:-}" ] \
  || die "APPLE_CODESIGN_P12_BASE64 is required"
[ -n "${APPLE_CODESIGN_P12_PASSWORD:-}" ] \
  || die "APPLE_CODESIGN_P12_PASSWORD is required"
command -v security >/dev/null 2>&1 || die "security is required"
command -v base64 >/dev/null 2>&1 || die "base64 is required"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/portico-signing.XXXXXX")"
keychain_path="$temp_dir/release-signing.keychain-db"
p12_path="$temp_dir/release-signing.p12"
keychain_password="$(openssl rand -hex 24 2>/dev/null || printf '%s' "temporary-keychain-$$-$(date +%s)")"
original_keychains=()

while IFS= read -r keychain; do
  keychain="$(printf '%s' "$keychain" | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
  [ -n "$keychain" ] && original_keychains+=("$keychain")
done < <(security list-keychains -d user)

cleanup() {
  set +e
  if [ "${#original_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1
  fi
  security delete-keychain "$keychain_path" >/dev/null 2>&1
  rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

if [ "$(uname -s)" = "Darwin" ]; then
  printf '%s' "$APPLE_CODESIGN_P12_BASE64" | base64 -D >"$p12_path"
else
  printf '%s' "$APPLE_CODESIGN_P12_BASE64" | base64 --decode >"$p12_path"
fi
[ -s "$p12_path" ] || die "decoded signing certificate is empty"

security create-keychain -p "$keychain_password" "$keychain_path" >/dev/null
security set-keychain-settings -lut 21600 "$keychain_path" >/dev/null
security unlock-keychain -p "$keychain_password" "$keychain_path" >/dev/null
security import "$p12_path" \
  -k "$keychain_path" \
  -P "$APPLE_CODESIGN_P12_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple: \
  -s \
  -k "$keychain_password" \
  "$keychain_path" \
  >/dev/null
security list-keychains -d user -s "$keychain_path" "${original_keychains[@]}" >/dev/null
security find-identity -v -p codesigning "$keychain_path" \
  | grep -Fq "$EXPECTED_IDENTITY" \
  || die "expected signing identity is missing: $EXPECTED_IDENTITY"

export CSC_KEYCHAIN="$keychain_path"
set +e
"$@"
command_status=$?
set -e
exit "$command_status"
