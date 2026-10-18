#!/usr/bin/env bash
# Start Gemini on the latest code. Use this instead of typing `gemini`.
#
#   ./scripts/gemini.sh                    refresh ~/Downloads/CoffeeFlow-gemini to origin/main, start Gemini there
#   GEMINI_REF=<branch> ./scripts/gemini.sh   …to origin/<branch> instead (review an open PR)
#   ./scripts/gemini.sh -p "review PR #418"   any arguments go to gemini
#
# Every launch fetches and moves the checkout first, so a Gemini session always
# starts on what is deployed, never on whichever branch your own checkout is on.
# If main moves while Gemini is open, GEMINI.md's freshness check catches it on
# the next review and asks you to restart through this script.
#
# Tip: after the first run, alias the WORKSPACE copy (always current, unlike a
# checkout on an old branch):
#   echo "alias gem='$HOME/Downloads/CoffeeFlow-gemini/scripts/gemini.sh'" >> ~/.zshrc
set -euo pipefail

# Inside main(): the refresh below may rewrite this file while it runs.
main() {
  HERE="$(cd "$(dirname "$0")" && pwd)"
  WS="${GEMINI_WORKSPACE:-$HOME/Downloads/CoffeeFlow-gemini}"
  GEMINI_WORKSPACE="$WS" bash "$HERE/gemini-workspace.sh" "${GEMINI_REF:-main}"

  # Run from the workspace's own copy of the scripts, so it keeps working even if
  # the checkout this was launched from is on an old branch.
  cd "$WS"
  exec gemini "$@"
}
main "$@"
