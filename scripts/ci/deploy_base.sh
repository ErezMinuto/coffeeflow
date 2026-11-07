#!/usr/bin/env bash
# Which commit should a push deploy be diffed from?
#
#   gh run list ... --json headSha,status,conclusion | scripts/ci/deploy_base.sh <head-sha> <push-before-sha>
#
# Prints the base commit on stdout.
#
# Why not just the push's own "before" commit: deploy-edge-functions.yml runs in
# one concurrency group, and GitHub keeps only ONE waiting run per group. When a
# third push arrives while one run is deploying and another is waiting, the
# waiting run is CANCELLED. The surviving run diffed only its own push, so the
# cancelled push's functions were never deployed (2026-11-05: #491's
# generate-campaign consent fix was merged but never reached production).
#
# So the base is the head of the newest push run that actually ran to the end
# (success or failure, never cancelled or skipped), as long as it is an
# ancestor of <head-sha>. Everything merged since then is in the diff. A failed
# run counts as "ran": the functions it refused or failed on show up red on that
# run and are re-deployed by hand; counting only successes would make one
# refused function widen every later diff, and the guard would then refuse
# functions that later pushes changed again.
#
# Falls back to <push-before-sha> with a warning on stderr when no finished run
# is listed (first run, or the listing failed) or the newest one is not an
# ancestor of <head-sha> (history rewritten); that is the old behaviour.
set -euo pipefail

HEAD_SHA="$1"
BEFORE="$2"

runs="$(cat)"
base="$(printf '%s' "$runs" | jq -r --arg head "$HEAD_SHA" '
  [ .[]? | select(.status == "completed")
         | select(.conclusion == "success" or .conclusion == "failure")
         | select(.headSha != $head) ]
  | first | .headSha // empty' 2>/dev/null || true)"

if [ -z "$base" ]; then
  echo "deploy_base: no finished push run listed; using the push's before commit" >&2
  echo "$BEFORE"; exit 0
fi
if ! git cat-file -e "$base^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$base" "$HEAD_SHA"; then
  echo "deploy_base: last deployed commit ${base:0:7} is not an ancestor of ${HEAD_SHA:0:7}; using the push's before commit" >&2
  echo "$BEFORE"; exit 0
fi
# A before commit OLDER than the last finished run cannot happen on a linear
# main, but if it does, take whichever is older so nothing is skipped.
if git cat-file -e "$BEFORE^{commit}" 2>/dev/null && git merge-base --is-ancestor "$BEFORE" "$base" && [ "$BEFORE" != "$base" ]; then
  echo "$BEFORE"; exit 0
fi
echo "$base"
