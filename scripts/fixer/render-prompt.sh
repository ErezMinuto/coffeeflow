#!/usr/bin/env bash
# render-prompt.sh — interpolate the fixer prompt template and expose it as a
# multiline GitHub Actions output (`text`), ready to feed claude-code-action's
# `prompt:` input.
#
# Only two placeholders are filled (kept deliberately small):
#   ${REPO_SLUG}    owner/repo, from $GITHUB_REPOSITORY
#   ${BASE_BRANCH}  the PR base, from $BASE_BRANCH (default: main)
#
# Env:
#   GITHUB_REPOSITORY   provided by Actions (e.g. minuto/coffeeflow)
#   BASE_BRANCH         optional, defaults to 'main'
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="${here}/fixer-prompt.md"

REPO_SLUG="${GITHUB_REPOSITORY:-unknown/repo}"
BASE_BRANCH="${BASE_BRANCH:-main}"

rendered=$(sed -e "s|\${REPO_SLUG}|${REPO_SLUG}|g" \
               -e "s|\${BASE_BRANCH}|${BASE_BRANCH}|g" \
               "$template")

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  # Multiline output via a random heredoc delimiter (GitHub's documented pattern).
  delim="EOF_$(date +%s)_$$"
  {
    echo "text<<${delim}"
    echo "$rendered"
    echo "${delim}"
  } >> "$GITHUB_OUTPUT"
else
  echo "$rendered"
fi
