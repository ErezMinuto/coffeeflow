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

# CLAUDE.md: these must always be deployed with --no-verify-jwt. Each one checks
# its own caller in code. This list mirrors every function that runs with
# verify_jwt=false in prod (2026-10-17); a deploy without the flag turns the
# gateway's JWT check back on, which rejects callers that send no Supabase JWT
# (Telegram, Resend, WooCommerce webhooks, Clerk tokens from the dashboard).
NO_VERIFY_JWT="coffee-bot employee-bot telegram-bot clerk-user-lookup marketing-advisor whatsapp-bot \
google-ads-draft meta-ads-draft attendance-export resend-webhook woo-webhook \
artisan-import attendance-reminder blog-publish email-automation-scheduler export-to-sheets \
forms-submit ga4-sync generate-campaign google-exchange-token google-search-sync \
meta-exchange-token meta-publish meta-sync purge-old-media rfm-sync set-post-faq \
visual-overlay woo-orders-sync woo-products-enrich woo-stock-check \
generate-product-faq set-product-faq update-product-description green-stock-alert supplier-invoices"
NO_VERIFY_JWT="$(echo $NO_VERIFY_JWT)"   # squash the line breaks to single spaces

# Prod's current verify_jwt for a function: "true", "false", or "" (not deployed
# or the API could not be reached).
prod_verify_jwt() {
  curl -s --max-time 20 -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$PROJECT_REF/functions/$1" 2>/dev/null \
    | grep -oE '"verify_jwt"[[:space:]]*:[[:space:]]*(true|false)' | grep -oE 'true|false' | head -1
}

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
      # Never flip a function from verify_jwt=false to true by accident: that
      # 401s every caller the function was built for. Add it to NO_VERIFY_JWT
      # (if false is right) or change prod on purpose first.
      if [ "$(prod_verify_jwt "$f")" = false ]; then
        echo "deploy-functions: $f runs with verify_jwt=false in $PROJECT_REF but is not in NO_VERIFY_JWT." >&2
        echo "  Deploying it would turn the gateway JWT check on. Refusing." >&2
        exit 1
      fi ;;
  esac
  echo "── $f ${flags[*]:-}"
  # ${a[@]+...} form: macOS bash 3.2 treats an empty array as unbound under set -u.
  "${CLI[@]}" functions deploy "$f" --project-ref "$PROJECT_REF" ${flags[@]+"${flags[@]}"}
done
echo "Done. Check for runtime errors with: ./scripts/logs.sh errors"
