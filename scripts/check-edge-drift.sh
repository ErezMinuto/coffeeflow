#!/usr/bin/env bash
# Diff every deployed edge function against the committed source.
#
# Read-only: downloads and diffs, never deploys, never writes to Supabase.
#
# RATCHET. Functions listed in .github/edge-drift-allowlist.txt are known,
# accepted drift — they are reported but do not fail the build, so the job is
# green today and only fires when something NEW drifts. The list is also
# checked in the other direction: a function that is listed but has come back
# into sync fails the build, telling you to delete its line. That is what stops
# the allowlist from quietly becoming a permanent excuse.
#
# Local use:  SUPABASE_ACCESS_TOKEN=… bash scripts/check-edge-drift.sh
set -uo pipefail

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALLOWLIST="$ROOT/.github/edge-drift-allowlist.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

is_allowed() {
  [ -f "$ALLOWLIST" ] || return 1
  grep -vE '^\s*(#|$)' "$ALLOWLIST" | awk '{print $1}' | grep -qx "$1"
}

new_drift=(); known_drift=(); clean=(); missing=(); stale_allow=(); failed=()

# Which slugs actually exist in the project. Without this, a transient download
# failure is indistinguishable from "this function was never deployed" — and
# silently filing it as the latter SUPPRESSES the drift it was meant to catch.
# (It did exactly that on the first run here: two different totals, 17 and 9,
# because a handful of downloads flaked and were quietly skipped.)
supabase functions list --project-ref "$PROJECT_REF" > "$WORK/deployed.txt" 2>/dev/null || {
  echo "::error::could not list deployed functions — check SUPABASE_ACCESS_TOKEN"; exit 1
}
is_deployed() { awk -F'|' '{print $3}' "$WORK/deployed.txt" | tr -d ' ' | grep -qx "$1"; }

for dir in "$ROOT"/supabase/functions/*/; do
  fn="$(basename "$dir")"
  [ "$fn" = "_shared" ] && continue
  [ -f "$dir/index.ts" ] || continue

  if ! is_deployed "$fn"; then missing+=("$fn"); continue; fi

  out="$WORK/$fn"; mkdir -p "$out"
  # CRITICAL: every function bundles its OWN snapshot of seo-agent/* and
  # _shared/*, so downloading several into one directory overwrites those
  # files and gives a false reading. One directory each.
  ok=0
  for attempt in 1 2 3; do
    if (cd "$out" && supabase functions download "$fn" --project-ref "$PROJECT_REF" >/dev/null 2>&1); then ok=1; break; fi
    sleep $((attempt * 2))
  done
  live="$out/supabase/functions/$fn/index.ts"
  if [ "$ok" -ne 1 ] || [ ! -f "$live" ]; then
    # Deployed but unreadable after 3 tries. NEVER treat this as "no drift".
    failed+=("$fn"); continue
  fi

  if diff -q "$dir/index.ts" "$live" >/dev/null 2>&1; then
    clean+=("$fn")
    is_allowed "$fn" && stale_allow+=("$fn")
  else
    p=$(diff "$dir/index.ts" "$live" | grep -c '^>')
    g=$(diff "$dir/index.ts" "$live" | grep -c '^<')
    if is_allowed "$fn"; then known_drift+=("$fn (prod-only: $p, git-only: $g)")
    else                   new_drift+=("$fn (prod-only: $p, git-only: $g)")
    fi
  fi
done

echo "── in sync (${#clean[@]}) ───────────────────────────────"
printf '  %s\n' "${clean[@]:-(none)}"
echo
echo "── known drift, allowlisted (${#known_drift[@]}) ────────"
printf '  · %s\n' "${known_drift[@]:-(none)}"
echo
[ "${#missing[@]}" -gt 0 ] && { echo "── not deployed (${#missing[@]}) ────────────────────────"; printf '  %s\n' "${missing[@]}"; echo; }

fail=0
if [ "${#failed[@]}" -gt 0 ]; then
  echo "── COULD NOT COMPARE (${#failed[@]}) ────────────────────"
  printf '  ⚠️  %s — deployed but download failed 3×; drift status UNKNOWN\n' "${failed[@]}"
  echo
  fail=1
fi

if [ "${#stale_allow[@]}" -gt 0 ]; then
  echo "── ALLOWLIST IS STALE (${#stale_allow[@]}) ──────────────"
  printf '  ✅ %s — back in sync; delete its line from .github/edge-drift-allowlist.txt\n' "${stale_allow[@]}"
  echo
  fail=1
fi

if [ "${#new_drift[@]}" -gt 0 ]; then
  echo "── NEW DRIFT (${#new_drift[@]}) ─────────────────────────"
  printf '  ❌ %s\n' "${new_drift[@]}"
  echo
  echo "prod-only lines are live code that a deploy from git would DELETE."
  echo "git-only lines are committed work that production has never run."
  echo "Reconcile with a three-way merge before deploying either way."
  fail=1
fi

[ "$fail" -eq 0 ] && echo "✅ No new drift."
exit $fail
