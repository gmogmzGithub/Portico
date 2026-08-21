#!/usr/bin/env bash

# Helpers for repository .env guards. These functions never print or export
# credential values; comparisons happen through mode-0600 files in a private
# working directory.

portico_extract_nonempty_cloudsmith_assignment() {
  local input_path="$1"
  local output_path="$2"

  : >"$output_path"
  chmod 600 "$output_path" 2>/dev/null || true
  [ -f "$input_path" ] || return 0

  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function assignment_value(value, first, remainder, closing) {
      value = trim(value)
      first = substr(value, 1, 1)
      if (first == "\"" || first == "\047") {
        remainder = substr(value, 2)
        closing = index(remainder, first)
        if (closing > 0) return trim(substr(remainder, 1, closing - 1))
        return trim(remainder)
      }
      sub(/[[:space:]]+#.*$/, "", value)
      return trim(value)
    }
    {
      normalized = $0
      sub(/^[[:space:]]*/, "", normalized)
      sub(/^export[[:space:]]+/, "", normalized)
      if (normalized !~ /^CLOUDSMITH_API_KEY[[:space:]]*=/) next
      value = normalized
      sub(/^[^=]*=/, "", value)
      value = assignment_value(value)
      if (length(value) > 0) {
        assignment = $0
      } else {
        assignment = ""
      }
    }
    END { if (length(assignment) > 0) print assignment }
  ' "$input_path" >"$output_path"
}

portico_repository_cloudsmith_assignment_changed() {
  local current_env="$1"
  local snapshot_env="$2"
  local work_dir="$3"
  local current_assignment="$work_dir/current-cloudsmith.assignment"
  local snapshot_assignment="$work_dir/snapshot-cloudsmith.assignment"

  mkdir -p "$work_dir"
  chmod 700 "$work_dir" 2>/dev/null || true
  portico_extract_nonempty_cloudsmith_assignment "$current_env" "$current_assignment"
  portico_extract_nonempty_cloudsmith_assignment "$snapshot_env" "$snapshot_assignment"

  [ -s "$current_assignment" ] && ! cmp -s "$current_assignment" "$snapshot_assignment"
}
