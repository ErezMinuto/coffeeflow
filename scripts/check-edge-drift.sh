#!/usr/bin/env bash
# Diff every deployed edge function against the committed source.
#
# Exits non-zero if any function differs, so CI turns silent prod/git drift
# into a visible failure. Read-only: downloads and diffs, never deploys.
#
# Local use:  SUPABASE_ACCESS_TOKEN=… bash scripts/check-edge-drift.sh
set -uo pipefail

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# CRITICAL: every function bundles its OWN snapshot of shared modules
# (seo-agent/*, _shared/*), so downloading several into one directory
# overwrites those files and produces a false reading. One directory each.
drifted=(); clean=(); missing=()

for dir in "$ROOT"/supabase/functions/*/; do
  fn="$(basename "$dir")"
  [ "$fn" = "_shared" ] && continue
  [ -f "$dir/index.ts" ] || continue

  out="$WORK/$fn"; mkdir -p "$out"
  if ! (cd "$out" && supabase functions download "$fn" --project-ref "$PROJECT_REF" >/dev/null 2>&1); then
    missing+=("$fn")          # never deployed, or deploy-only-in-git — not drift
    continue
  fi

  live="$out/supabase/functions/$fn/index.ts"
  if [ ! -f "$live" ]; then missing+=("$fn"); continue; fi

  if diff -q "$dir/index.ts" "$live" >/dev/null 2>&1; then
    clean+=("$fn")
  else
    only_prod=$(diff "$dir/index.ts" "$live" | grep -c '^>')
    only_git=$(diff "$dir/index.ts" "$live" | grep -c '^<')
    drifted+=("$fn (prod-only lines: $only_prod, git-only lines: $only_git)")
  fi
done

echo "── in sync (${#clean[@]}) ─────────────────────────────"
printf '  %s\n' "${clean[@]:-(none)}"
echo
echo "── not deployed (${#missing[@]}) ──────────────────────"
printf '  %s\n' "${missing[@]:-(none)}"
echo

if [ "${#drifted[@]}" -eq 0 ]; then
  echo "✅ No drift. Every deployed function matches this commit."
  exit 0
fi

echo "── DRIFT (${#drifted[@]}) ─────────────────────────────"
printf '  ❌ %s\n' "${drifted[@]}"
echo
echo "prod-only lines are live code that a deploy from git would DELETE."
echo "git-only lines are committed work that production has never run."
echo "Reconcile with a three-way merge before deploying either way."
exit 1
