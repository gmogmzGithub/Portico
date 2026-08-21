#!/usr/bin/env bash

set -euo pipefail
umask 077

IDENTITY="${APPLE_CODESIGN_IDENTITY:-Developer ID Application: Portico, Inc. (AJDA86F3YP)}"
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$#" -gt 0 ] || die "usage: with-apple-signing-key.sh <command> [args...]"
[ -n "${APPLE_CODESIGN_P12_BASE64:-}" ] || die "APPLE_CODESIGN_P12_BASE64 is required"
[ -n "${APPLE_CODESIGN_P12_PASSWORD:-}" ] || die "APPLE_CODESIGN_P12_PASSWORD is required"

temporary="$(mktemp -d "${TMPDIR:-/tmp}/portico-broker-keychain.XXXXXX")"
keychain="$temporary/release.keychain-db"
p12="$temporary/release.p12"
password="$(openssl rand -hex 24)"
original=()
while IFS= read -r entry; do
  entry="$(printf '%s' "$entry" | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
  [ -n "$entry" ] && original+=("$entry")
done < <(security list-keychains -d user)

cleanup() {
  set +e
  if [ "${#original[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${original[@]}" >/dev/null 2>&1
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

printf '%s' "$APPLE_CODESIGN_P12_BASE64" | base64 -D >"$p12"
[ -s "$p12" ] || die "decoded signing certificate is empty"
security create-keychain -p "$password" "$keychain" >/dev/null
security set-keychain-settings -lut 21600 "$keychain" >/dev/null
security unlock-keychain -p "$password" "$keychain" >/dev/null
security import "$p12" -k "$keychain" -P "$APPLE_CODESIGN_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original[@]}" >/dev/null
security find-identity -v -p codesigning "$keychain" | grep -Fq "$IDENTITY" \
  || die "expected signing identity is missing: $IDENTITY"

export CSC_KEYCHAIN="$keychain"
"$@"

