#!/bin/bash
# Three-way equivalence check for debug.sh bundle redaction.
#
# redact_file has three engines: perl (fast path), one combined sed pass,
# and the per-pattern sed loop (the historical behavior — the pattern
# array is the verbatim list of the original sed_inplace expressions).
# All three MUST produce byte-identical output; this script proves it over
# a synthetic fixture that exercises every pattern (including multi-match
# and order-sensitive lines) plus any real files passed as arguments.
#
# Usage:
#   tests/manual/debug-redaction-equivalence.sh [extra-corpus-file ...]
#
# Exits non-zero on any divergence. Run from the repo root (the .env
# pattern pass is included when .env exists, matching real collection).

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEBUG_SH="${REPO_ROOT}/src/scripts/debug.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

extract_fn() {
    awk -v fn="$2" '$0 ~ "^"fn"\\(\\)" {infn=1} infn {print} infn && /^}/ {exit}' "$1"
}

{
    echo 'REDACTION_SED_FILE=""'
    sed -n "/^GENERIC_REDACTION_PATTERNS=(/,/^)/p" "$DEBUG_SH"
    echo 'GENERIC_REDACTION_SED_FILE=""'
    echo 'PERL_REDACTION_SCRIPT=""'
    for fn in sed_inplace escape_sed_pattern build_redaction_sed_file \
        apply_sed_file build_generic_redaction_sed_file \
        build_perl_redaction_script redact_file; do
        extract_fn "$DEBUG_SH" "$fn"
        echo
    done
} > "$WORK/fns.sh"

mkdir -p "$WORK/corpus"
cat > "$WORK/corpus/synthetic.log" <<'EOF'
plain line that must never change
Authorization: Bearer abc123.def-GHI_jkl=
Authorization: Basic dXNlcjpwYXNz==
sent Bearer tok-en.123_456= to upstream
{"access_token":"sk-secret-a","refresh_token": "rt-b","id_token":  "idt-c"}
{"client_secret":"cs-d","api_key":"ak-e","apiKey":"AK-f","token":"tk-g"}
MY_API_KEY=supersecret1 SOME_TOKEN=xyz,PASSWORD_FIELD=hunter2 AUTH_THING=abc"quoted
[DEBUGGING_TOOLS] step=3 content=full user chat content here
[DEBUGGING_TOOLS] whatever Content preview: sensitive preview text
[SYSTEM-PROMPT-DEBUG] len=100 preview=the entire system prompt
[FOLLOW-UP] id=1 content_preview=follow up content
[Skills] catalog Message preview: skill msg preview
[Skills] catalog Message: skill msg full
2026-08-07 args_preview={"tool":"send_message","channel":"#private"} trailing
prefix Original messages: [{"role":"user","content":"hi"}]
prefix Transformed messages: [{"role":"user","content":"hi2"}]
prefix Parsed line data: {"delta":"secret stream"}
[ChatCapabilities] Raw Redis values: {"chat_skills":["a"]}
[ChatCapabilities] Parsed: {"tools":["b"]}
[ChatCapabilities] Full response: {"everything":"c"}
[ChatCapabilities] Emitting to room user:u-123 with event: {"payload":true}
POST generate_chat_completion: {"messages":[...]}
middleware form_data: {"stream":true} content=nested content after form data
DEBUG response={"body":"resp"} and content=after-response too
standalone content=the chat text
worker tool_call={"name":"jira_create"}
Authorization: Bearer first AND Authorization: Bearer second-on-same-line
no match here either
EOF
for extra in "$@"; do
    [ -f "$extra" ] && cp "$extra" "$WORK/corpus/$(basename "$extra")"
done

# Controlled .env so the .env-value pass is exercised deterministically,
# including the perl interpolation hazards (@ in emails, $, quotes, dots).
mkdir -p "$WORK/envroot"
cat > "$WORK/envroot/.env" <<'EOF'
PORTICO_USER_ID='someone@example.invalid'
FAKE_SECRET_VALUE=s3cr3t$value.with@sigils
QUOTED_TOKEN="quoted-token-value-123"
BOOL_VALUE=true
NUM_VALUE=42
EOF
cat >> "$WORK/corpus/synthetic.log" <<'EOF'
env sweep: user someone@example.invalid logged in
env sweep: secret literal s3cr3t$value.with@sigils appeared
env sweep: quoted-token-value-123 raw in log
env sweep: true and 42 must survive (JSON primitives are never env-redacted)
EOF

run_engine() { # dir engine
    local dir="$1" engine="$2"
    bash -c '
        source "'"$WORK"'/fns.sh"
        cd "'"$WORK"'/envroot" && build_redaction_sed_file; cd - >/dev/null
        case "'"$engine"'" in
            perl)
                build_generic_redaction_sed_file
                build_perl_redaction_script
                [ -n "$PERL_REDACTION_SCRIPT" ] || { echo "perl engine unavailable" >&2; exit 2; }
                ;;
            combined-sed)
                build_generic_redaction_sed_file
                [ -n "$GENERIC_REDACTION_SED_FILE" ] || { echo "combined sed unavailable" >&2; exit 2; }
                ;;
            per-pattern) ;; # both compiled scripts left empty -> legacy loop
        esac
        for f in "'"$dir"'"/*; do redact_file "$f"; done
        rm -f "$REDACTION_SED_FILE" "$GENERIC_REDACTION_SED_FILE" "$PERL_REDACTION_SCRIPT"
        exit 0
    '
}

status=0
for engine in perl combined-sed per-pattern; do
    cp -R "$WORK/corpus" "$WORK/$engine"
    echo "== engine: $engine"
    time run_engine "$WORK/$engine" "$engine" || { echo "ENGINE FAILED: $engine"; status=1; }
done

for engine in perl combined-sed; do
    if diff -r "$WORK/per-pattern" "$WORK/$engine" > /dev/null; then
        echo "PASS: $engine output byte-identical to per-pattern (historical) behavior"
    else
        echo "FAIL: $engine output diverges from per-pattern behavior:"
        diff -r "$WORK/per-pattern" "$WORK/$engine" | head -20
        status=1
    fi
done

leak_status=0
for engine in perl combined-sed per-pattern; do
    if grep -rE "supersecret1|hunter2|sk-secret-a|full user chat content|someone@portico\.com|quoted-token-value-123" "$WORK/$engine" >/dev/null; then
        echo "FAIL: known-sensitive fixture strings survived redaction (engine: $engine)"
        leak_status=1
    fi
done
if grep -rF 'true and 42 must survive' "$WORK/perl" >/dev/null; then
    echo "PASS: JSON-primitive env values correctly left intact"
else
    echo "FAIL: over-redaction — primitive control line was altered"
    leak_status=1
fi
if [ "$leak_status" -eq 0 ]; then
    echo "PASS: leak scan clean on all engines"
else
    status=1
fi

exit "$status"
