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
# Comparison form: production serves the bundle with TypeScript types ERASED,
# and the CLI on GitHub runners re-prints it on top (blank lines dropped,
# semicolons added, trailing commas removed). Both sides therefore go through
# esbuild's TS→JS transform, which erases types and prints one fixed layout,
# and then lose all whitespace and trailing commas. A whitespace-only
# difference is invisible, which is the right trade: real prod-only code
# always adds characters. Anything that still differs is reported as drift,
# so the guard fails CLOSED, never open.
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

canon() {  # file → canonical, layout-free code on stdout
  local f="$1" tmp
  tmp="$(mktemp "$WORK/canon.XXXXXX")" && mv "$tmp" "$tmp.${f##*.}" && tmp="$tmp.${f##*.}"
  cp "$f" "$tmp" 2>/dev/null || return 1
  # Production returns the bundle with TypeScript types ERASED (type
  # annotations and type-only imports gone). Running both sides through
  # esbuild's TS→JS transform erases types the same way and re-prints the code
  # in one fixed layout, with comments dropped.
  if ! esbuild --loader=ts --format=esm --log-level=error < "$tmp" > "$tmp.js" 2>"$tmp.err"; then
    echo "  (esbuild could not parse ${f##*/}: $(head -c 200 "$tmp.err" | tr '\n' ' '))" >&3
    cp "$tmp" "$tmp.js"     # unparseable → raw text, still compared (fails closed)
  fi
  # Drop ALL whitespace and any comma directly before a closer: what is left is
  # layout-free.
  tr -d '[:space:]' < "$tmp.js" | sed -E 's/,([]})])/\1/g'
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
      cmp <(canon "$f" 3>/dev/null) <(canon "$WORK/git.${rel##*.}" 3>/dev/null) 2>&1 \
        | sed -nE 's/.*(char|byte) ([0-9]+).*/\2/p' | while read -r at; do
          s=$(( at > 120 ? at - 120 : 0 ))
          echo "      canon git : $(canon "$WORK/git.${rel##*.}" 3>/dev/null | cut -c$((s+1))-$((at+120)))"
          echo "      canon prod: $(canon "$f" 3>/dev/null | cut -c$((s+1))-$((at+120)))"
        done >&3
      diff <(sed -E 's/[[:space:]]+/ /g;s/^ //;s/ $//;/^$/d' "$WORK/git.${rel##*.}") \
           <(sed -E 's/[[:space:]]+/ /g;s/^ //;s/ $//;/^$/d' "$f") \
        | grep -E '^[<>]' | head -4 | cut -c1-160 | sed 's/^/      /' >&3
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
