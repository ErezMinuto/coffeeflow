#!/usr/bin/env bash
# Tests scripts/ci/deploy_base.sh against a scratch git history.
#   bash scripts/ci/deploy_base_test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cd "$T" && git init -q && git config user.email t@t && git config user.name t
c() { git commit -q --allow-empty -m "$1" && git rev-parse HEAD; }
A=$(c A); B=$(c B); C=$(c C); D=$(c D)
git checkout -q -b side "$A"; X=$(c X); git checkout -q -
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 — got ${2:0:7} want ${3:0:7}"; fails=$((fails+1)); fi; }
run() { printf '%s' "$1" | bash "$HERE/deploy_base.sh" "$2" "$3" 2>/dev/null; }
j() { printf '{"headSha":"%s","status":"%s","conclusion":"%s"}' "$1" "$2" "$3"; }

# The 2026-11-05 case: run for B deployed, run for C was cancelled while
# waiting, run for D starts. D's own parent is C, but C never deployed.
check "cancelled waiting run: base goes back to the last finished run" \
  "$(run "[$(j "$D" in_progress '' ),$(j "$C" completed cancelled),$(j "$B" completed success)]" "$D" "$C")" "$B"
check "normal push: base = parent" \
  "$(run "[$(j "$D" in_progress ''),$(j "$C" completed success)]" "$D" "$C")" "$C"
check "failed run counts as finished" \
  "$(run "[$(j "$C" completed failure),$(j "$B" completed success)]" "$D" "$C")" "$C"
check "skipped run ignored" \
  "$(run "[$(j "$C" completed skipped),$(j "$B" completed success)]" "$D" "$C")" "$B"
check "own head ignored" \
  "$(run "[$(j "$D" completed success),$(j "$B" completed success)]" "$D" "$C")" "$B"
check "no runs listed: parent" "$(run "[]" "$D" "$C")" "$C"
check "listing broken: parent" "$(run "not json" "$D" "$C")" "$C"
check "last run not an ancestor: parent" "$(run "[$(j "$X" completed success)]" "$D" "$C")" "$C"
check "unknown sha: parent" "$(run "[$(j 0123456789012345678901234567890123456789 completed success)]" "$D" "$C")" "$C"
check "parent older than last run: parent (never skip)" \
  "$(run "[$(j "$C" completed success)]" "$D" "$B")" "$B"
warn="$(printf '[]' | bash "$HERE/deploy_base.sh" "$D" "$C" 2>&1 >/dev/null)"
check "fallback warns on stderr" "$([ -n "$warn" ] && echo y)" "y"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails FAILED"; exit 1; }
