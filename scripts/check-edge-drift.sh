#!/usr/bin/env bash
# Which deployed edge functions differ from the committed source?
#
#   SUPABASE_ACCESS_TOKEN=… bash scripts/check-edge-drift.sh          # all functions
#   SUPABASE_ACCESS_TOKEN=… bash scripts/check-edge-drift.sh fn1 fn2  # some
#
# Read-only: downloads and compares, never deploys, never writes to Supabase.
#
# Each function is checked with scripts/ci/edge_prod_guard.sh against HEAD, the
# same comparison the deploy workflow trusts: the WHOLE deployed bundle (index.ts
# plus every _shared/ and seo-agent/ file it carries), canonicalised through
# esbuild because production serves code with TypeScript types erased.
#
# The old version compared raw index.ts text and reported 100% drift on the
# runner, because of that type erasure. Kept from it: a run where nothing at all
# matches is rejected as a broken comparison, never reported as real drift.
#
# Needs: supabase CLI, esbuild, git. Exit 1 when any function drifts or could
# not be compared.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HEAD_SHA="$(git rev-parse HEAD)"
GUARD="$ROOT/scripts/ci/edge_prod_guard.sh"
OUT="${DRIFT_REPORT:-$(mktemp)}"

if [ "$#" -gt 0 ]; then
  fns=("$@")
else
  fns=()
  for d in supabase/functions/*/; do
    n="$(basename "$d")"
    case "$n" in _shared|seo-agent) continue ;; esac
    [ -f "$d/index.ts" ] && fns+=("$n")
  done
fi

clean=(); drift=(); missing=(); failed=()
: > "$OUT"
for fn in "${fns[@]}"; do
  verdict="$(bash "$GUARD" "$fn" "$HEAD_SHA" "$HEAD_SHA" 2>"$OUT.$fn")" || true
  case "$verdict" in
    base|head) clean+=("$fn") ;;
    new)       missing+=("$fn") ;;
    drift)     drift+=("$fn")
               { echo "### $fn"; grep -E '^\s+(differs|only in prod|\()' "$OUT.$fn"; echo; } >> "$OUT" ;;
    *)         failed+=("$fn") ;;
  esac
  rm -f "$OUT.$fn"
  printf '  %-30s %s\n' "$fn" "${verdict:-error}"
done

echo
echo "in sync: ${#clean[@]}   drifted: ${#drift[@]}   not deployed: ${#missing[@]}   could not compare: ${#failed[@]}"
[ "${#missing[@]}" -gt 0 ] && echo "not deployed: ${missing[*]}"
[ "${#failed[@]}" -gt 0 ]  && echo "could not compare (download failed): ${failed[*]}"
if [ "${#drift[@]}" -gt 0 ]; then
  echo
  echo "DRIFTED (production differs from git @ ${HEAD_SHA:0:7}):"
  cat "$OUT"
  echo "prod-only code would be DELETED by a deploy from git; git-only code has"
  echo "never run in production. Reconcile each before it is next deployed."
fi

compared=$(( ${#clean[@]} + ${#drift[@]} ))
if [ "$compared" -gt 10 ] && [ "${#clean[@]}" -eq 0 ]; then
  echo
  echo "RESULT REJECTED: $compared functions compared and none in sync. That is a broken"
  echo "comparison, not universal drift. Investigate edge_prod_guard.sh's canon()."
  exit 1
fi

# Machine-readable lines for the workflow summary.
{
  echo "CLEAN=${clean[*]:-}"
  echo "DRIFT=${drift[*]:-}"
  echo "MISSING=${missing[*]:-}"
  echo "FAILED=${failed[*]:-}"
} > "$OUT.vars"

[ "${#drift[@]}" -eq 0 ] && [ "${#failed[@]}" -eq 0 ]
