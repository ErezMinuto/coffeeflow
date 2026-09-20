#!/usr/bin/env bash
# Report which CoffeeFlow credentials are available — WITHOUT revealing any
# value. This is how a session discovers what it can do, instead of asking for
# secrets to be pasted into chat.
#
# Usage:
#   ./scripts/secrets-doctor.sh             # what is set
#   ./scripts/secrets-doctor.sh --bootstrap # first pull from Vault, then report
#   ./scripts/secrets-doctor.sh --live      # also prove the main creds still work
#
# Output shows only: name, status, length, and the first 3 characters — enough to
# catch the `sb_secret_…` vs `eyJ…` service-key trap, not enough to be a
# credential. Names come from scripts/secret-names.txt.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMES_FILE="$DIR/secret-names.txt"

# Works whether the credentials are already in the shell (the ~/.zshenv loader on
# the Mac, or a cloud environment's injected variables) or only in the store.
# shellcheck source=/dev/null
. "$DIR/load-secrets.sh"

for arg in "$@"; do
  if [[ "$arg" == "--bootstrap" ]]; then
    # shellcheck source=/dev/null
    . "$DIR/bootstrap-from-db.sh" --quiet
  fi
done

read_tier() {
  awk -v want="$1" '
    /^#[[:space:]]*bootstrap[[:space:]]*$/ { tier="bootstrap"; next }
    /^#[[:space:]]*vault[[:space:]]*$/     { tier="vault";     next }
    /^[[:space:]]*#/ || /^[[:space:]]*$/   { next }
    tier==want                             { print $1 }
  ' "$NAMES_FILE"
}

missing_bootstrap=0

report() {
  local name="$1" tier="$2" val="${!1:-}"
  if [[ -z "$val" ]]; then
    if [[ "$tier" == bootstrap ]]; then
      printf '  %-28s ✗ MISSING — nothing works without this\n' "$name"
      missing_bootstrap=$((missing_bootstrap + 1))
    else
      printf '  %-28s ·  not set (add to Vault under this exact name)\n' "$name"
    fi
  else
    printf '  %-28s ✓ set   len=%-4s prefix=%s…\n' "$name" "${#val}" "${val:0:3}"
  fi
}

echo "CoffeeFlow credentials available to this session"
echo "── bootstrap (configured per environment) ───────────────────────────────"
while read -r v; do [[ -n "$v" ]] && report "$v" bootstrap; done < <(read_tier bootstrap)
echo "── from Supabase Vault ──────────────────────────────────────────────────"
while read -r v; do [[ -n "$v" ]] && report "$v" vault; done < <(read_tier vault)

# Format trap documented in CLAUDE.md: PostgREST writes break on sb_secret_ keys.
if [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" && "${SUPABASE_SERVICE_ROLE_KEY:0:3}" != "eyJ" ]]; then
  echo
  echo "⚠  SUPABASE_SERVICE_ROLE_KEY is not the eyJ… JWT format."
  echo "   The sb_secret_… format breaks PostgREST UPDATE/INSERT. Swap it."
fi

if [[ " $* " == *" --live "* ]]; then
  echo
  echo "── live checks ──────────────────────────────────────────────────────────"

  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      https://api.supabase.com/v1/projects)
    [[ "$code" == 200 ]] \
      && echo "  Supabase Management API   ✓ authenticated" \
      || echo "  Supabase Management API   ✗ HTTP $code (token expired or revoked?)"
  fi

  if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      "$SUPABASE_URL/rest/v1/products?select=id&limit=1")
    [[ "$code" == 200 ]] \
      && echo "  PostgREST (service role)  ✓ reachable" \
      || echo "  PostgREST (service role)  ✗ HTTP $code"

    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -X POST "$SUPABASE_URL/rest/v1/rpc/ops_list_secret_names" \
      -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" -d '{}')
    case "$code" in
      200) echo "  Vault reader RPC          ✓ present" ;;
      404) echo "  Vault reader RPC          ✗ not installed — apply supabase/migrations/20260920_ops_profile_and_vault_reader.sql" ;;
      *)   echo "  Vault reader RPC          ✗ HTTP $code" ;;
    esac
  fi
fi

echo
if (( missing_bootstrap > 0 )); then
  echo "$missing_bootstrap bootstrap credential(s) missing."
  echo "  Local Mac : ./scripts/install-secrets.sh --link, then fill the store."
  echo "  Cloud     : set them in the cloud environment's variables."
  exit 1
fi
echo "Bootstrap complete. Anything still unset belongs in Vault —"
echo "add it there, never paste a credential into chat."
