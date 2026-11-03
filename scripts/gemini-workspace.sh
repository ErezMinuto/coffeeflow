#!/usr/bin/env bash
# Give Gemini its own checkout of current main, so its QA reviews read the code
# that is actually deployed — not whatever branch your own checkout is on.
#
#   ./scripts/gemini-workspace.sh            create or refresh ~/Downloads/CoffeeFlow-gemini at origin/main
#   ./scripts/gemini-workspace.sh <branch>   point it at origin/<branch> instead (to review an open PR)
#   GEMINI_WORKSPACE=/some/path ./scripts/gemini-workspace.sh
#
# Usually you don't call this directly: ./scripts/gemini.sh refreshes and
# starts Gemini in one go.
#
# It is a git worktree in detached-HEAD state: no branch of its own, nothing to
# commit, and your own checkout (its branch, its uncommitted edits) is never
# touched. GEMINI.md forbids Gemini from switching branches, so refreshing is
# done here, by you. Refuses to refresh if someone edited files in it.
set -euo pipefail

# Everything runs inside main(): bash parses the whole function before running
# it, so the checkout below may replace this very file mid-run (when it is run
# from the Gemini workspace itself) without breaking the run.
main() {
  # The repo this script lives in (works from any directory, and from the
  # Gemini workspace's own copy: worktrees share the same repository).
  ROOT="$(git -C "$(cd "$(dirname "$0")" && pwd)" rev-parse --show-toplevel)"
  WS="${GEMINI_WORKSPACE:-$HOME/Downloads/CoffeeFlow-gemini}"
  REF="origin/${1:-main}"

  git -C "$ROOT" fetch --quiet origin
  git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}" >/dev/null \
    || { echo "gemini-workspace: no such ref $REF" >&2; exit 1; }

  if [ -e "$WS/.git" ]; then
    if [ -n "$(git -C "$WS" status --porcelain)" ]; then
      echo "gemini-workspace: $WS has local changes; Gemini must not edit files." >&2
      git -C "$WS" status --short >&2
      echo "  Look at them, then: git -C \"$WS\" checkout -- . && git -C \"$WS\" clean -fd" >&2
      exit 1
    fi
    git -C "$WS" checkout --quiet --detach "$REF"
  elif [ -e "$WS" ]; then
    echo "gemini-workspace: $WS exists but is not a git checkout; move it or set GEMINI_WORKSPACE." >&2
    exit 1
  else
    git -C "$ROOT" worktree add --quiet --detach "$WS" "$REF"
  fi

  echo "Gemini workspace: $WS"
  echo "  at $REF = $(git -C "$WS" log -1 --format='%h %s (%cr)')"
  echo "  run:  cd \"$WS\" && gemini"
}
main "$@"
