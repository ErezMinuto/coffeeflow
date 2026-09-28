#!/usr/bin/env bash
# Deploy edge functions to PROD with the right flags — one command, from the Mac
# or from a cloud session started on a phone.
#
#   ./scripts/deploy-functions.sh coffee-bot mission-worker   # named functions
#   ./scripts/deploy-functions.sh --shared                    # everything that bundles
#                                                             # _shared/claude.ts or seo-agent/
#   ./scripts/deploy-functions.sh --all                       # every function
#   PROJECT_REF=emnijrlfiuwbddjahkzn ./scripts/deploy-functions.sh ...   # dev instead
#
# Why a script: deploys used to be hand-typed loops, which (a) forgot
# --no-verify-jwt on the bot/webhook functions, and (b) ran from outside the repo
# and deployed whatever supabase/functions folder happened to be in the cwd.
# This always deploys from the repo it lives in, applies the flag per function,
# and stops on the first failure so nothing half-ships silently.
#
# Needs SUPABASE_ACCESS_TOKEN (the Mac store, or Vault via session-start.sh).
# Uses the installed supabase CLI, or fetches the pinned one through npm.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
. "$REPO/scripts/load-secrets.sh"

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
CLI_VERSION="2.98.1"

# CLAUDE.md: these must always be deployed with --no-verify-jwt — the bots and
# webhooks, which Telegram/Clerk call without a Supabase JWT.
#
# Everything else keeps whatever verify_jwt prod has now (below). A deploy used
# to turn it back ON: the 2026-09-27 --shared deploy did that to ten functions
# pg_cron called without a header, and mission-worker, and with it the daily IG
# story, stopped. Those cron jobs now send the service-role key
# (20260928_cron_auth_header.sql), so those functions keep verify_jwt on.
NO_VERIFY_JWT="coffee-bot employee-bot telegram-bot clerk-user-lookup marketing-advisor"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "deploy-functions: SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "  Mac   : ./scripts/secrets-doctor.sh, then fill the store." >&2
  echo "  Cloud : set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment settings" >&2
  echo "          and start a new session; the token then comes from Vault." >&2
  exit 1
fi

if command -v supabase >/dev/null 2>&1; then
  CLI=(supabase)
elif [ -x /opt/homebrew/bin/supabase ]; then
  CLI=(/opt/homebrew/bin/supabase)
else
  CLI=(npx -y "supabase@$CLI_VERSION")
fi

list_functions() {
  for d in supabase/functions/*/; do
    n="$(basename "$d")"
    case "$n" in _shared|seo-agent) continue ;; esac
    [ -f "$d/index.ts" ] || continue
    if [ "$1" = all ] || grep -rqE "from ['\"]\.\./(_shared/claude|seo-agent/)" "$d"; then
      echo "$n"
    fi
  done
}

case "${1:-}" in
  '')       echo "usage: $0 <function...> | --shared | --all" >&2; exit 2 ;;
  --all)    set -- $(list_functions all) ;;
  --shared) set -- $(list_functions shared) ;;
esac

echo "Deploying ${#} function(s) to $PROJECT_REF from $(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD)"
for f in "$@"; do
  [ -f "supabase/functions/$f/index.ts" ] || { echo "deploy-functions: no supabase/functions/$f/index.ts" >&2; exit 1; }
  flags=()
  case " $NO_VERIFY_JWT " in
    *" $f "*) flags+=(--no-verify-jwt) ;;
    *)
      # Not on the list: keep whatever prod has now. A deploy must never flip
      # verify_jwt on for a function someone deliberately turned it off for.
      current="$(curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        "https://api.supabase.com/v1/projects/$PROJECT_REF/functions/$f" 2>/dev/null || true)"
      if printf '%s' "$current" | grep -Eq '"verify_jwt"[[:space:]]*:[[:space:]]*false'; then
        flags+=(--no-verify-jwt)
      fi
      ;;
  esac
  echo "── $f ${flags[*]:-}"
  # ${a[@]+...} form: macOS bash 3.2 treats an empty array as unbound under set -u.
  "${CLI[@]}" functions deploy "$f" --project-ref "$PROJECT_REF" ${flags[@]+"${flags[@]}"}
done
echo "Done. Check for runtime errors with: ./scripts/logs.sh errors"
