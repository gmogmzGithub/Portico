#!/bin/bash
set -e

state_dir="${MOCK_STATE_DIR:?}"
services_file="$state_dir/services.txt"
certs_file="$state_dir/certs.txt"
calls_file="$state_dir/calls.log"
command_name="$1"
shift

remove_first_line() {
  local target="$1"
  local source_file="$2"
  local temporary_file="$source_file.tmp"
  awk -v target="$target" '
    BEGIN { removed = 0 }
    !removed && $0 == target { removed = 1; next }
    { print }
    END { if (!removed) exit 44 }
  ' "$source_file" > "$temporary_file" || {
    status=$?
    rm -f "$temporary_file"
    return "$status"
  }
  mv "$temporary_file" "$source_file"
}

case "$command_name" in
  dump-keychain)
    printf 'dump-keychain\n' >> "$calls_file"
    [ "${MOCK_DUMP_FAIL:-0}" = "1" ] && exit 1
    while IFS= read -r service; do
      [ -n "$service" ] || continue
      printf 'keychain: "%s"\nclass: "genp"\nattributes:\n    "svce"<blob>="%s"\n' "$1" "$service"
    done < "$services_file"
    ;;
  delete-generic-password)
    service=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -s) service="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'delete-generic-password|%s\n' "$service" >> "$calls_file"
    [ "${MOCK_KEEP_SERVICE:-}" = "$service" ] && exit 1
    remove_first_line "$service" "$services_file"
    ;;
  find-certificate)
    printf 'find-certificate\n' >> "$calls_file"
    [ "${MOCK_CERT_QUERY_FAIL:-0}" = "1" ] && exit 1
    while IFS= read -r sha; do
      [ -n "$sha" ] || continue
      printf 'SHA-1 hash: %s\n' "$sha"
    done < "$certs_file"
    ;;
  delete-certificate)
    sha=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -Z) sha="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'delete-certificate|%s\n' "$sha" >> "$calls_file"
    [ "${MOCK_KEEP_CERT:-0}" = "1" ] && exit 1
    remove_first_line "$sha" "$certs_file"
    ;;
  *)
    printf 'unexpected|%s\n' "$command_name" >> "$calls_file"
    exit 2
    ;;
esac
