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

WORK="$(mktemp -d)"
cleanup() { chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK" 2>/dev/null; true; }
trap cleanup EXIT

canon() {  # file → canonical, layout-free code on stdout
  local f="$1" tmp
  tmp="$(mktemp "$WORK/canon.XXXXXX")" && mv "$tmp" "$tmp.${f##*.}" && tmp="$tmp.${f##*.}"
  cp "$f" "$tmp" 2>/dev/null || return 1
  # Production returns the bundle with TypeScript types ERASED (type
  # annotations and type-only imports gone). Running both sides through
  # esbuild's TS→JS transform erases types the same way and re-prints the code
  # in one fixed layout. --minify-whitespace also drops the comments that sit
  # inside objects and arrays, which a plain transform keeps but production
  # has already stripped. --minify-syntax evens out what Deno's compiler
  # rewrites on its own (redundant parentheses, `new Map()` → `new Map`); it
  # only ever turns code into an equivalent form, so a real change still shows.
  #
  # Class fields are the one place the two sides print differently. Git has
  # `private i = 0; constructor(private s: string) {}`; production's emitter
  # (Deno, useDefineForClassFields off) serves `s; i; constructor(s) {
  # this.s = s; this.i = 0; }`. esbuild's default (define semantics, keeps
  # `i=0` as a field) cannot turn one into the other, which refused a
  # byte-identical artisan-import on 2026-10-18. So both sides are read with
  # useDefineForClassFields=false, which moves every initialiser into the
  # constructor as `this.x = …` and drops bare `x;` declarations; a second,
  # plain-JS pass then folds the moved assignments into the same
  # comma-joined form the first pass gives code that was already there.
  # Initialisers and constructor bodies stay in full, so a changed or added
  # field still shows; only a field declared with no value and never assigned
  # is invisible. Target is pinned so a new esbuild default cannot reshuffle.
  local opts=(--format=esm --target=esnext --minify-whitespace --minify-syntax --log-level=error)
  if ! esbuild --loader=ts "${opts[@]}" --tsconfig-raw='{"compilerOptions":{"useDefineForClassFields":false}}' < "$tmp" > "$tmp.1.js" 2>"$tmp.err" \
     || ! esbuild --loader=js "${opts[@]}" < "$tmp.1.js" > "$tmp.js" 2>>"$tmp.err"; then
    echo "  (esbuild could not parse ${f##*/}: $(head -c 200 "$tmp.err" | tr '\n' ' '))" >&3
    cp "$tmp" "$tmp.js"     # unparseable → raw text, still compared (fails closed)
  fi
  # Drop ALL whitespace and any comma directly before a closer: what is left is
  # layout-free.
  tr -d '[:space:]' < "$tmp.js" | sed -E 's/,([]})])/\1/g'
}

# `edge_prod_guard.sh --canon <file>` prints just the canonical form, so
# scripts/ci/edge_canon_test.sh can pin it without touching production.
if [ "${1:-}" = "--canon" ]; then canon "${2:?file}" 3>&2; exit; fi

FN="${1:?function}"; BASE="${2:?base sha}"; HEAD="${3:?head sha}"
PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
ROOT="$(git rev-parse --show-toplevel)"

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
      if [ "${GUARD_HISTORY:-0}" = "1" ]; then
        # Which committed version of this file is production running, if any?
        # A match means production is merely BEHIND git (safe to deploy);
        # no match means production carries code that is in no commit.
        local live_c hit="" n=0 c
        live_c="$(canon "$f" 3>/dev/null)"
        for c in $(git -C "$ROOT" log --format=%H -n 300 "$rev" -- "$rel"); do
          n=$((n + 1))
          git -C "$ROOT" show "$c:$rel" > "$WORK/hist.${rel##*.}" 2>/dev/null || continue
          if [ "$(canon "$WORK/hist.${rel##*.}" 3>/dev/null)" = "$live_c" ]; then hit="$c"; break; fi
        done
        if [ -n "$hit" ]; then
          echo "    BEHIND: prod = git@${hit:0:7} ($(git -C "$ROOT" log -1 --format=%cs "$hit")), $((n - 1)) later commit(s) never deployed" >&3
        else
          echo "    PROD-ONLY: matches none of the last $n committed versions" >&3
        fi
      fi
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
