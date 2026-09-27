#!/usr/bin/env bash
# SessionStart hook: make every CoffeeFlow credential available to the session,
# wherever it runs — the Mac, or a cloud session started from a phone.
#
#   1. If the two bootstrap values are configured (cloud environment settings,
#      or the Mac store), fetch everything else from Supabase Vault into the
#      local chmod-600 store (bootstrap-from-db.sh --cache).
#   2. Tell Claude Code to source load-secrets.sh before every command, via
#      $CLAUDE_ENV_FILE. A hook's own exports die with the hook's shell; this is
#      what carries them into the session's later Bash calls.
#   3. Print the doctor report (names, lengths, prefixes — never values).
#
# Never fails the session: every step degrades to "credential not available".

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0
REPO="$(pwd)"

# Local Mac store first, so a Mac session never touches the network here.
. "$REPO/scripts/load-secrets.sh"

if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  # Sourced, not piped: a pipeline would run it in a subshell. Its messages go
  # to stderr and name secrets, never values.
  . "$REPO/scripts/bootstrap-from-db.sh" --cache --quiet >&2
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # The line holds a PATH, not a secret: the values stay in the chmod-600 store.
  line=". \"$REPO/scripts/load-secrets.sh\""
  grep -qxF "$line" "$CLAUDE_ENV_FILE" 2>/dev/null || printf '%s\n' "$line" >> "$CLAUDE_ENV_FILE"
fi

[ -x "$REPO/scripts/secrets-doctor.sh" ] && "$REPO/scripts/secrets-doctor.sh" 2>&1
exit 0
