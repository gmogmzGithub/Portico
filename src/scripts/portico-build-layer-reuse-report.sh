#!/usr/bin/env bash

# portico-build-layer-reuse-report — layer-cache reuse diagnostics for PORTICO Docker
# builds (PORTICO-205 Phase 2).
#
# Answers "which Dockerfile stages/layers failed cache reuse in this build,
# and how many new bytes did the build cycle add?" from three angles:
#   analyze   parse BuildKit --progress=plain logs into per-stage cache
#             hit/miss tables with the first-miss (cache-bust) instruction
#   snapshot  record docker system df, docker buildx du, and the macOS
#             OrbStack data.img.raw allocated size
#   diff      report NET whole-engine deltas between two snapshots
#
# The byte metrics are deliberately labeled NET, engine-wide deltas: BuildKit
# cache sharing, concurrent builds, and gc eviction make exact per-image
# attribution impossible from totals alone. The per-record `buildx du
# --verbose` capture in each snapshot supports manual attribution.
#
# This tool is read-only with respect to Docker state: it only ever runs
# `docker system df` and `docker buildx du`.
#
# Works standalone and as the opt-in build_docker_images.sh hook
# (portico_BUILD_LAYER_REPORT=1). Attempt logs written by build_docker_images.sh
# prefix every line with "[<image-name>] "; analyze strips that prefix.

set -euo pipefail

DEFAULT_BUILDER="${BUILDX_BUILDER:-portico-multiarch-v030}"

usage() {
  cat <<'EOF'
Usage:
  portico-build-layer-reuse-report.sh analyze <build-log> [<build-log>...] [--out DIR]
  portico-build-layer-reuse-report.sh snapshot <out-dir> [--builder NAME]
  portico-build-layer-reuse-report.sh diff <before-dir> <after-dir> [--out DIR]

Commands:
  analyze   Parse one or more BuildKit --progress=plain build logs (including
            build_docker_images.sh per-image attempt logs, whose lines carry a
            "[image-name] " prefix). Each log file is treated as one build
            invocation: vertex numbers are scoped per file and never merged
            across files. Reports, per (stage, platform): total steps, cache
            hits, executed steps and their wall time, and the FIRST MISS — the
            lowest non-FROM step that did not come from cache, i.e. the point
            where the cache chain broke. FROM steps are classified separately
            ("base"): a FROM finishing as "DONE 0.0s" on a warm build is
            normal resolution work, not a cache miss.
  snapshot  Record `docker system df`, `docker buildx du` (summary and
            --verbose, both builder-scoped), and the macOS host-level OrbStack
            data image (data.img.raw) allocated size into <out-dir>.
  diff      Print NET whole-engine deltas between two snapshot directories:
            Images / Build Cache rows of docker system df, the buildx builder
            cache Total, and exact host data.img.raw allocated bytes.

Options:
  --builder NAME   buildx builder for snapshot (default: BUILDX_BUILDER env or
                   portico-multiarch-v030). Applied to both the summary
                   and the --verbose `docker buildx du` capture.
  --out DIR        Also write the analyze/diff report into DIR (created if
                   needed; never auto-deleted).

Environment:
  portico_ORBSTACK_DATA_IMG  Override path of the OrbStack data image used for
                         host-level disk reporting.
  BUILDX_BUILDER         Default builder name for snapshot.

Exit codes:
  0  success (a report with cache misses still exits 0 — it is a report)
  1  environment failure (unreadable snapshot dirs, snapshot write failure)
  2  usage error (unknown command, missing/unreadable inputs)
EOF
}

fail_usage() {
  echo "ERROR: $1" >&2
  usage >&2
  exit 2
}

warn() {
  echo "WARNING: $1" >&2
}

# --- host-level OrbStack data image helpers (same contract as Phase 1's ---
# --- portico-docker-cleanup.sh; duplicated deliberately so Phase 1 scripts   ---
# --- have zero regression surface from this tool)                        ---

resolve_orbstack_data_img() {
  if [ -n "${portico_ORBSTACK_DATA_IMG:-}" ]; then
    if [ -f "$portico_ORBSTACK_DATA_IMG" ]; then
      printf '%s\n' "$portico_ORBSTACK_DATA_IMG"
      return 0
    fi
    return 1
  fi

  local match
  for match in "$HOME/Library/Group Containers/"*orbstack*/data/data.img.raw; do
    if [ -f "$match" ]; then
      printf '%s\n' "$match"
      return 0
    fi
  done
  return 1
}

host_data_img_allocated_kib() {
  local data_img="$1"
  du -k "$data_img" 2>/dev/null | awk 'NR == 1 { print $1; exit }'
}

format_bytes() {
  awk -v bytes="$1" '
    function human(x,    units, i) {
      split("B kB MB GB TB PB", units, " ")
      i = 1
      while ((x >= 1000 || x <= -1000) && i < 6) { x /= 1000; i++ }
      printf "%.2f %s", x, units[i]
    }
    BEGIN { human(bytes + 0) }
  '
}

# Docker CLI human sizes are decimal (kB=10^3, MB=10^6, ...). Prints integer
# bytes, or "unavailable" for values it cannot parse (e.g. "N/A").
parse_human_size() {
  awk -v value="$1" '
    BEGIN {
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      if (value !~ /^-?[0-9]+(\.[0-9]+)?[ \t]*(B|kB|KB|MB|GB|TB)$/) {
        print "unavailable"
        exit 0
      }
      unit = value
      gsub(/^-?[0-9]+(\.[0-9]+)?[ \t]*/, "", unit)
      number = value
      gsub(/[ \t]*(B|kB|KB|MB|GB|TB)$/, "", number)
      mult = 1
      if (unit == "kB" || unit == "KB") mult = 1000
      else if (unit == "MB") mult = 1000000
      else if (unit == "GB") mult = 1000000000
      else if (unit == "TB") mult = 1000000000000
      printf "%.0f\n", number * mult
    }
  '
}

# --- analyze -----------------------------------------------------------------

analyze_one_log() {
  local log_file="$1"

  awk '
    # Strip the "[image-name] " prefix build_docker_images.sh adds via sed
    # when the remainder is a BuildKit vertex line.
    {
      line = $0
      if (line ~ /^\[[^]]*\] #[0-9]/) {
        sub(/^\[[^]]*\] /, "", line)
      }
    }

    line !~ /^#[0-9]+ / { next }

    {
      vertex = substr(line, 2)
      sub(/ .*$/, "", vertex)
      rest = substr(line, length(vertex) + 3)
    }

    rest == "CACHED" {
      state[vertex] = "CACHED"
      next
    }

    rest ~ /^DONE [0-9.]+s/ {
      state[vertex] = "DONE"
      dur = rest
      sub(/^DONE /, "", dur)
      sub(/s.*$/, "", dur)
      duration[vertex] = dur + 0
      next
    }

    rest ~ /^ERROR/ {
      state[vertex] = "ERROR"
      next
    }

    rest == "CANCELED" || rest ~ /^CANCELED/ {
      state[vertex] = "CANCELED"
      next
    }

    # Vertex header: "#N [<content>] INSTRUCTION..."
    rest ~ /^\[[^]]*\] / || rest ~ /^\[[^]]*\]$/ {
      content = rest
      sub(/^\[/, "", content)
      instr = content
      sub(/\].*$/, "", content)
      idx = index(instr, "] ")
      if (idx > 0) {
        instr = substr(instr, idx + 2)
      } else {
        instr = ""
      }

      if (content == "internal" || content == "auth" ||
          content ~ /^internal / || content ~ /^auth /) {
        class[vertex] = "internal"
        next
      }

      # content forms: "i/m", "stage i/m", "linux/arch i/m",
      # "linux/arch stage i/m"
      n = split(content, tok, " ")
      if (n < 1 || tok[n] !~ /^[0-9]+\/[0-9]+$/) {
        class[vertex] = "other"
        next
      }

      split(tok[n], im, "/")
      step_index[vertex] = im[1] + 0
      step_total[vertex] = im[2] + 0

      platform = ""
      stage = ""
      first = 1
      if (n >= 2 && tok[1] ~ /^(linux|windows|darwin)\//) {
        platform = tok[1]
        first = 2
      }
      for (i = first; i < n; i++) {
        stage = (stage == "" ? tok[i] : stage " " tok[i])
      }
      if (stage == "") stage = "(default)"

      vplatform[vertex] = platform
      vstage[vertex] = stage
      vinstr[vertex] = instr
      if (instr ~ /^FROM /) {
        class[vertex] = "base"
      } else {
        class[vertex] = "step"
      }
      groupkey = stage SUBSEP platform
      groups[groupkey] = 1
      next
    }
  END {
    internal_count = 0
    for (v in class) if (class[v] == "internal") internal_count++

    printf "  internal/auth vertices: %d\n", internal_count

    # Portable sort of group keys (macOS/BSD awk has no asorti).
    n_groups = 0
    for (groupkey in groups) {
      n_groups++
      sorted_groups[n_groups] = groupkey
    }
    for (i = 2; i <= n_groups; i++) {
      tmp = sorted_groups[i]
      j = i - 1
      while (j >= 1 && sorted_groups[j] > tmp) {
        sorted_groups[j + 1] = sorted_groups[j]
        j--
      }
      sorted_groups[j + 1] = tmp
    }

    total_misses = 0
    total_incomplete = 0
    for (g = 1; g <= n_groups; g++) {
      groupkey = sorted_groups[g]
      split(groupkey, parts, SUBSEP)
      stage = parts[1]
      platform = parts[2]

      steps = 0; cached = 0; executed = 0; base = 0
      exec_seconds = 0
      incomplete = 0
      first_miss_idx = -1

      for (v in vstage) {
        if (vstage[v] != stage || vplatform[v] != platform) continue
        if (class[v] == "base") {
          base++
          continue
        }
        if (class[v] != "step") continue
        steps++
        s = (v in state) ? state[v] : ""
        if (s == "CACHED") {
          cached++
        } else if (s == "DONE" || s == "ERROR") {
          executed++
          if (s == "DONE") exec_seconds += duration[v]
          if (first_miss_idx < 0 || step_index[v] < first_miss_idx) {
            first_miss_idx = step_index[v]
            first_miss_instr = vinstr[v]
            first_miss_state = s
          }
        } else {
          incomplete++
          total_incomplete++
        }
      }

      label = stage
      if (platform != "") label = label " [" platform "]"
      printf "  stage %s: steps=%d cached=%d executed=%d base=%d executed_seconds=%.1f", \
        label, steps, cached, executed, base, exec_seconds
      if (incomplete > 0) printf " incomplete=%d", incomplete
      printf "\n"
      if (first_miss_idx >= 0) {
        total_misses += executed
        instr_out = first_miss_instr
        if (length(instr_out) > 100) instr_out = substr(instr_out, 1, 100) "..."
        printf "    FIRST MISS at step %d (%s): %s\n", first_miss_idx, first_miss_state, instr_out
      }
    }

    if (n_groups == 0) {
      printf "  no Dockerfile stage vertices found (not a --progress=plain BuildKit log?)\n"
    } else if (total_misses == 0 && total_incomplete == 0) {
      printf "  cache reuse: FULL (every cacheable non-FROM instruction was CACHED)\n"
    } else if (total_misses == 0) {
      printf "  cache reuse: INCONCLUSIVE (no misses, but %d step(s) never reached a terminal state — truncated/interrupted log?)\n", total_incomplete
    }
  }
  ' "$log_file"
}

cmd_analyze() {
  local out_dir=""
  local -a logs=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --out)
        [ "$#" -ge 2 ] || fail_usage "--out requires a directory argument"
        out_dir="$2"
        shift 2
        ;;
      -*)
        fail_usage "Unknown analyze option: $1"
        ;;
      *)
        logs+=("$1")
        shift
        ;;
    esac
  done

  [ "${#logs[@]}" -ge 1 ] || fail_usage "analyze requires at least one build log"

  local log_file
  for log_file in "${logs[@]}"; do
    [ -r "$log_file" ] || fail_usage "Build log is not readable: $log_file"
  done

  local report
  report="$(
    for log_file in "${logs[@]}"; do
      echo "=== $log_file ==="
      analyze_one_log "$log_file"
    done
  )"

  printf '%s\n' "$report"

  if [ -n "$out_dir" ]; then
    mkdir -p "$out_dir" || { echo "ERROR: cannot create report dir: $out_dir" >&2; exit 1; }
    printf '%s\n' "$report" > "$out_dir/layer-reuse-analysis.txt"
    echo "Report written: $out_dir/layer-reuse-analysis.txt"
  fi
}

# --- snapshot ----------------------------------------------------------------

cmd_snapshot() {
  local out_dir=""
  local builder="$DEFAULT_BUILDER"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --builder)
        [ "$#" -ge 2 ] || fail_usage "--builder requires a name argument"
        builder="$2"
        shift 2
        ;;
      -*)
        fail_usage "Unknown snapshot option: $1"
        ;;
      *)
        [ -z "$out_dir" ] || fail_usage "snapshot takes exactly one output directory"
        out_dir="$1"
        shift
        ;;
    esac
  done

  [ -n "$out_dir" ] || fail_usage "snapshot requires an output directory"
  mkdir -p "$out_dir" || { echo "ERROR: cannot create snapshot dir: $out_dir" >&2; exit 1; }

  {
    echo "timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "builder: $builder"
  } > "$out_dir/meta.txt"

  if command -v docker >/dev/null 2>&1 && docker system df > "$out_dir/docker-system-df.txt" 2>/dev/null; then
    :
  else
    warn "docker system df unavailable; snapshot records it as unavailable"
    echo "unavailable" > "$out_dir/docker-system-df.txt"
  fi

  if command -v docker >/dev/null 2>&1 && docker buildx du --builder "$builder" > "$out_dir/buildx-du.txt" 2>/dev/null; then
    :
  else
    warn "docker buildx du --builder $builder unavailable; snapshot records it as unavailable"
    echo "unavailable" > "$out_dir/buildx-du.txt"
  fi

  if command -v docker >/dev/null 2>&1 && docker buildx du --builder "$builder" --verbose > "$out_dir/buildx-du-verbose.txt" 2>/dev/null; then
    :
  else
    echo "unavailable" > "$out_dir/buildx-du-verbose.txt"
  fi

  local data_img allocated_kib
  if data_img="$(resolve_orbstack_data_img)"; then
    allocated_kib="$(host_data_img_allocated_kib "$data_img")"
    if [ -n "$allocated_kib" ]; then
      {
        echo "path: $data_img"
        echo "allocated_kib: $allocated_kib"
      } > "$out_dir/host-data-img.txt"
    else
      echo "unavailable" > "$out_dir/host-data-img.txt"
    fi
  else
    warn "no OrbStack data image found; host-level reporting unavailable"
    echo "unavailable" > "$out_dir/host-data-img.txt"
  fi

  echo "Snapshot written: $out_dir"
}

# --- diff --------------------------------------------------------------------

df_row_size_bytes() {
  local df_file="$1"
  local row="$2"

  awk -v row="$row" '
    index($0, row) == 1 {
      if ($NF ~ /^\(.*%\)$/) { print $(NF - 2) } else { print $(NF - 1) }
      exit
    }
  ' "$df_file"
}

buildx_du_total() {
  [ -r "$1" ] || return 0
  awk '$1 == "Total:" { print $2; exit }' "$1" 2>/dev/null || true
}

host_allocated_kib_from_snapshot() {
  [ -r "$1" ] || return 0
  awk '$1 == "allocated_kib:" { print $2; exit }' "$1" 2>/dev/null || true
}

print_delta_row() {
  local label="$1" before_human="$2" after_human="$3"
  local before_bytes after_bytes

  before_bytes="$(parse_human_size "${before_human:-}")"
  after_bytes="$(parse_human_size "${after_human:-}")"

  if [ "$before_bytes" = "unavailable" ] || [ "$after_bytes" = "unavailable" ]; then
    printf '  %-28s before=%s after=%s delta=unavailable\n' "$label" \
      "${before_human:-n/a}" "${after_human:-n/a}"
    return 0
  fi

  local delta=$((after_bytes - before_bytes))
  printf '  %-28s before=%s after=%s delta=%s (%s bytes)\n' "$label" \
    "$(format_bytes "$before_bytes")" "$(format_bytes "$after_bytes")" \
    "$(format_bytes "$delta")" "$delta"
}

cmd_diff() {
  local out_dir=""
  local -a dirs=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --out)
        [ "$#" -ge 2 ] || fail_usage "--out requires a directory argument"
        out_dir="$2"
        shift 2
        ;;
      -*)
        fail_usage "Unknown diff option: $1"
        ;;
      *)
        dirs+=("$1")
        shift
        ;;
    esac
  done

  [ "${#dirs[@]}" -eq 2 ] || fail_usage "diff requires exactly two snapshot directories"
  local before="${dirs[0]}" after="${dirs[1]}"
  local d
  for d in "$before" "$after"; do
    [ -d "$d" ] || fail_usage "Snapshot directory not found: $d"
    [ -r "$d/docker-system-df.txt" ] || fail_usage "Not a snapshot directory (missing docker-system-df.txt): $d"
  done

  local report
  report="$(
    echo "NET whole-engine deltas ($before -> $after)"
    echo "(builder-wide net values: cache sharing/eviction can mask per-image attribution;"
    echo " see buildx-du-verbose.txt in each snapshot for per-record forensics)"

    print_delta_row "docker images size" \
      "$(df_row_size_bytes "$before/docker-system-df.txt" "Images")" \
      "$(df_row_size_bytes "$after/docker-system-df.txt" "Images")"
    print_delta_row "docker build cache (default)" \
      "$(df_row_size_bytes "$before/docker-system-df.txt" "Build Cache")" \
      "$(df_row_size_bytes "$after/docker-system-df.txt" "Build Cache")"
    print_delta_row "buildx builder cache total" \
      "$(buildx_du_total "$before/buildx-du.txt")" \
      "$(buildx_du_total "$after/buildx-du.txt")"

    local before_kib after_kib
    before_kib="$(host_allocated_kib_from_snapshot "$before/host-data-img.txt")"
    after_kib="$(host_allocated_kib_from_snapshot "$after/host-data-img.txt")"
    if [ -n "$before_kib" ] && [ -n "$after_kib" ]; then
      local delta_kib=$((after_kib - before_kib))
      printf '  %-28s before=%s after=%s delta=%s (%s bytes)\n' \
        "host data.img.raw allocated" \
        "$(format_bytes $((before_kib * 1024)))" \
        "$(format_bytes $((after_kib * 1024)))" \
        "$(format_bytes $((delta_kib * 1024)))" "$((delta_kib * 1024))"
      echo "  Note: OrbStack compacts its data image asynchronously; treat the host"
      echo "  delta as a whole-engine net value measured at snapshot time."
    else
      printf '  %-28s unavailable\n' "host data.img.raw allocated"
    fi
  )"

  printf '%s\n' "$report"

  if [ -n "$out_dir" ]; then
    mkdir -p "$out_dir" || { echo "ERROR: cannot create report dir: $out_dir" >&2; exit 1; }
    printf '%s\n' "$report" > "$out_dir/layer-reuse-diff.txt"
    echo "Report written: $out_dir/layer-reuse-diff.txt"
  fi
}

# --- main --------------------------------------------------------------------

[ "$#" -ge 1 ] || fail_usage "a command is required"

COMMAND="$1"
shift

case "$COMMAND" in
  analyze)  cmd_analyze "$@" ;;
  snapshot) cmd_snapshot "$@" ;;
  diff)     cmd_diff "$@" ;;
  -h|--help|help) usage ;;
  *) fail_usage "Unknown command: $COMMAND" ;;
esac
