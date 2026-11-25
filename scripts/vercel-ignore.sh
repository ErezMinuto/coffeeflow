#!/bin/sh
# Vercel "Ignored Build Step" for both projects (vercel.json ignoreCommand,
# which may be at most 256 characters, so the logic lives here).
# Vercel reads the exit code: 0 = skip the build, 1 = build, anything else = the
# deploy errors. Args: git pathspecs to compare, relative to the project root.
#
# Vercel's clone is shallow, so the last deployed commit may be missing: then,
# and on any other git error, build.
B="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "$B^{commit}" 2>/dev/null || exit 1
git diff --quiet "$B" HEAD -- "$@"
c=$?
[ "$c" -le 1 ] && exit "$c"
exit 1
