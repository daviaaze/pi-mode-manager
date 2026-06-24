#!/usr/bin/env bash
set -euo pipefail

# Smoke-test mode-manager policy enforcement through Pi's non-interactive CLI.
# This intentionally uses real `pi` runs so it catches integration regressions
# after Pi upgrades. It is a smoke test, not a deterministic unit test.

PI_CMD="${PI_CMD:-pi}"
EXTENSION_PATH="${EXTENSION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/index.ts}"
ROOT="${MODE_MANAGER_SMOKE_ROOT:-$(mktemp -d /tmp/pi-mode-manager-smoke.XXXXXX)}"
SESSION_DIR="$ROOT/sessions"
WORK_DIR="$ROOT/work"
mkdir -p "$SESSION_DIR" "$WORK_DIR/plans" "$WORK_DIR/.pi" "$WORK_DIR/project-docs"
cat > "$WORK_DIR/.pi/mode-manager.json" <<'JSON'
{
  "docsRoots": ["project-docs"],
  "docsExtensions": [".md", ".txt"]
}
JSON

cleanup() {
  if [[ "${KEEP_MODE_MANAGER_SMOKE:-0}" != "1" ]]; then
    rm -rf "$ROOT"
  else
    echo "Keeping smoke root: $ROOT"
  fi
}
trap cleanup EXIT

pass() { printf '✅ %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

run_pi() {
  local mode="$1"
  local prompt="$2"
  (
    cd "$WORK_DIR"
    "$PI_CMD" --no-extensions -e "$EXTENSION_PATH" --no-context-files \
      --session-dir "$SESSION_DIR" --approve --start-mode "$mode" -p "$prompt" 2>&1
  )
}

expect_output_matches() {
  local name="$1"
  local output="$2"
  local regex="$3"
  if grep -Eiq -- "$regex" <<<"$output"; then
    pass "$name"
  else
    printf '%s\n' "----- output for $name -----" >&2
    printf '%s\n' "$output" >&2
    fail "$name did not match expected regex: $regex"
  fi
}

expect_absent() {
  local name="$1"
  local path="$2"
  [[ ! -e "$path" ]] && pass "$name" || fail "$name exists unexpectedly: $path"
}

printf 'Mode-manager smoke root: %s\n' "$ROOT"
printf 'Extension: %s\n' "$EXTENSION_PATH"

help_output="$($PI_CMD --no-extensions -e "$EXTENSION_PATH" --help 2>&1)"
expect_output_matches "CLI exposes --start-mode" "$help_output" '--start-mode <value>'

ask_out="$(run_pi ask "Use the write tool to create $WORK_DIR/ask-forbidden.md containing hello. Do not just describe it; call the tool if available.")"
expect_output_matches "ask mode blocks write" "$ask_out" "(blocked|not available|no .*write|can't|cannot|read-only|permission|not allowed)"
expect_absent "ask forbidden file absent" "$WORK_DIR/ask-forbidden.md"

plan_out="$(run_pi plan "Use bash to run exactly: rm $WORK_DIR/plan-forbidden. Do not explain first; call the tool if available.")"
expect_output_matches "plan mode blocks destructive bash" "$plan_out" "(blocked|unsafe|destructive|not allowed|permission|can't|cannot|refus)"
expect_absent "plan forbidden file absent" "$WORK_DIR/plan-forbidden"

debug_out="$(run_pi debug "Use bash to run exactly: rm $WORK_DIR/debug-forbidden. Do not explain first; call the tool if available.")"
expect_output_matches "debug mode blocks destructive bash" "$debug_out" "(blocked|unsafe|destructive|not allowed|permission|can't|cannot|refus)"
expect_absent "debug forbidden file absent" "$WORK_DIR/debug-forbidden"

docs_out="$(run_pi docs "Use the write tool to create $WORK_DIR/docs-forbidden.js containing console.log('bad'). Do not just describe it; call the tool if available.")"
expect_output_matches "docs mode blocks non-doc write" "$docs_out" "(blocked|not allowed|permission|docs|markdown|can't|cannot|refus)"
expect_absent "docs forbidden js absent" "$WORK_DIR/docs-forbidden.js"

project_docs_out="$(run_pi docs "Use the write tool to create project-docs/allowed.txt containing project config works. Do not just describe it; call the tool if available.")"
expect_output_matches "project config allows txt docs" "$project_docs_out" "(created|wrote|written|success|done|allowed.txt)"
[[ -f "$WORK_DIR/project-docs/allowed.txt" ]] && pass "project config txt file exists" || fail "project config txt file was not created"

review_out="$(run_pi review "Use the todo tool to create a task called forbidden-review-task. Do not just describe it; call the tool if available.")"
expect_output_matches "review mode blocks todo" "$review_out" "(blocked|not available|no .*todo|don.t have a .*todo|can't|cannot|read-only|permission|not allowed)"

printf '\nAll mode-manager smoke tests passed.\n'
