#!/usr/bin/env bash
# Source this to make CoffeeFlow credentials available, wherever the session runs:
#
#   . scripts/load-secrets.sh
#
# Resolution order (first one that has a value wins, nothing is overwritten):
#   1. variables already in the environment  — this is how CLOUD sessions and CI
#      get them (the environment's own secret config injects them)
#   2. ~/.config/coffeeflow/secrets.env      — this is how a LOCAL Mac session
#      gets them (normally auto-loaded by the ~/.zshenv block, but sourcing this
#      works even from a shell the guard did not cover)
#
# The point of the ordering: a script written against "$SUPABASE_SERVICE_ROLE_KEY"
# behaves identically on the Mac, in a cloud session, and in CI — so tasks sent
# from a phone need no special handling.
#
# Never prints a value. See scripts/secrets-doctor.sh to inspect what is loaded.

__cf_store="${COFFEEFLOW_SECRETS_FILE:-$HOME/.config/coffeeflow/secrets.env}"

if [ -r "$__cf_store" ]; then
  # Load into the environment without clobbering anything already set, so an
  # explicitly-exported or cloud-injected value always beats the file.
  while IFS= read -r __cf_line || [ -n "$__cf_line" ]; do
    case "$__cf_line" in
      ''|'#'*) continue ;;
    esac
    __cf_name="${__cf_line%%=*}"
    case "$__cf_name" in
      *[!A-Za-z0-9_]*|'') continue ;;
    esac
    if [ -z "$(eval "printf '%s' \"\${$__cf_name:-}\"")" ]; then
      eval "export $__cf_line"
    fi
  done < "$__cf_store"
  unset __cf_line __cf_name
fi

unset __cf_store
