#!/usr/bin/env bash
# Is it safe to deploy <function> over what production runs right now?
#
#   scripts/ci/edge_prod_guard.sh <function> <base-sha> <head-sha>
#
# Downloads the function's deployed bundle and compares every file in it with
# the same file in git at <base-sha> (the state before this push) and at
# <head-sha> (the state being deployed).
#
#   exit 0  prints "base"   prod == git@base   → safe: only this push's change ships
#   exit 0  prints "head"   prod == git@head   → already live, nothing to deploy
#   exit 0  prints "new"    function not deployed yet
#   exit 3  prints "drift"  prod matches neither → REFUSE. Production has code
#                           git doesn't (it would be deleted) or git has older
#                           undeployed work. A human reconciles, then deploys
#                           with the workflow's manual "force" run.
#   exit 4  prints "error"  could not download → REFUSE. Unknown is not "safe".
#
# Why compare against base and not just head: on 2026-08-21 six functions had
# production-only code (mission-worker had 480 live lines git never had). A
# deploy from git silently deletes that. Requiring prod == base before shipping
# head means a deploy can only ever add this push's diff.
#
# Comparison form: both sides go through `deno fmt`, then the whitespace token
# stream is compared with all whitespace and trailing commas removed. The CLI on GitHub runners returns the bundle re-printed
# (blank lines dropped, imports hoisted, trailing commas removed); deno fmt
# normalises quotes and semicolons, and stripping whitespace plus trailing
# commas absorbs what is left. A whitespace-only difference is invisible,
# which is the right trade: real prod-only code always adds characters. If a re-print still slips through, the result is a false
# "drift" — the guard fails CLOSED, never open.
set -uo pipefail

FN="${1:?function}"; BASE="${2:?base sha}"; HEAD="${3:?head sha}"
PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
cleanup() { chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK" 2>/dev/null; true; }
trap cleanup EXIT

# Deployed at all? (`functions list` prints a table; slug is column 3.)
if ! supabase functions list --project-ref "$PROJECT_REF" > "$WORK/list.txt" 2>"$WORK/list.err"; then
  echo "error"; echo "guard: cannot list functions: $(head -c 300 "$WORK/list.err")" >&2; exit 4
fi
if ! awk -F'|' '{print $3}' "$WORK/list.txt" | tr -d ' ' | grep -qx "$FN"; then
  echo "new"; exit 0
fi

live="$WORK/live"; mkdir -p "$live"
ok=0
for attempt in 1 2 3; do
  if (cd "$live" && supabase functions download "$FN" --project-ref "$PROJECT_REF" >/dev/null 2>&1); then ok=1; break; fi
  sleep $((attempt * 3))
done
if [ "$ok" -ne 1 ] || [ ! -f "$live/supabase/functions/$FN/index.ts" ]; then
  echo "error"; echo "guard: download of $FN failed 3x" >&2; exit 4
fi

canon() {  # file → canonical token stream on stdout
  local f="$1" tmp
  tmp="$(mktemp "$WORK/canon.XXXXXX")" && mv "$tmp" "$tmp.${f##*.}" && tmp="$tmp.${f##*.}"
  cp "$f" "$tmp" 2>/dev/null || return 1
  deno fmt --quiet "$tmp" >/dev/null 2>&1 || true   # unparseable → raw tokens, still compared
  # Drop ALL whitespace and any comma directly before a closer: what is left is
  # layout-free, so line-width decisions and trailing-comma style cancel out.
  tr -d '[:space:]' < "$tmp" | sed -E 's/,([]})])/\1/g'
}

# Compare every source file in the deployed bundle with git at a revision.
# Returns 0 when all match, and lists mismatches on fd 3.
matches_rev() {
  local rev="$1" rel f g=0
  while IFS= read -r f; do
    rel="${f#"$live"/}"                        # supabase/functions/<...>
    if ! git -C "$ROOT" cat-file -e "$rev:$rel" 2>/dev/null; then
      echo "  only in prod: $rel" >&3; g=1; continue
    fi
    git -C "$ROOT" show "$rev:$rel" > "$WORK/git.${rel##*.}"
    if ! cmp -s <(canon "$f") <(canon "$WORK/git.${rel##*.}"); then
      echo "  differs: $rel" >&3; g=1
      # Evidence for a human: the first differing lines, whitespace-normalised.
      # "<" is git, ">" is production.
      diff <(sed -E 's/[[:space:]]+/ /g;s/^ //;s/ $//;/^$/d' "$WORK/git.${rel##*.}") \
           <(sed -E 's/[[:space:]]+/ /g;s/^ //;s/ $//;/^$/d' "$f") \
        | grep -E '^[<>]' | head -8 | cut -c1-160 | sed 's/^/      /' >&3
    fi
  done < <(find "$live/supabase/functions" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) | sort)
  return $g
}

if matches_rev "$BASE" 3>"$WORK/base.diff"; then echo "base"; exit 0; fi
if matches_rev "$HEAD" 3>"$WORK/head.diff"; then echo "head"; exit 0; fi

echo "drift"
{
  echo "guard: production $FN matches neither $BASE nor $HEAD."
  echo "Files that differ from the pre-push commit:"
  cat "$WORK/base.diff"
} >&2
exit 3
