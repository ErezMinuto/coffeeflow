#!/usr/bin/env bash
# Deploy a single Supabase edge function and re-patch verify_jwt.
#
# Usage:
#   ./scripts/deploy-function.sh <function-name> <personal-access-token>
#
# Example:
#   ./scripts/deploy-function.sh coffee-bot sbp_xxxxxxxxxxxx

set -euo pipefail

FUNCTION=${1:?Usage: $0 <function-name> <personal-access-token>}
TOKEN=${2:?Usage: $0 <function-name> <personal-access-token>}
PROJECT_ID="ytydgldyeygpzmlxvpvb"
SUPABASE="/opt/homebrew/Cellar/supabase/2.75.0/bin/supabase"

echo "🚀 Deploying $FUNCTION..."
$SUPABASE functions deploy "$FUNCTION" --project-ref "$PROJECT_ID"

echo "🔓 Re-patching verify_jwt: false..."
curl -s -X PATCH "https://api.supabase.com/v1/projects/$PROJECT_ID/functions/$FUNCTION" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"verify_jwt": false}'

echo ""
echo "✅ Done!"
