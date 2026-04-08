#!/usr/bin/env bash
# Deploy a Supabase edge function and re-patch verify_jwt: false.
#
# Usage:
#   ./scripts/deploy-function.sh <function-name>
#
# Requires SUPABASE_ACCESS_TOKEN to be set in your environment:
#   export SUPABASE_ACCESS_TOKEN="sbp_xxxxxxxxxxxx"
# Add that line to ~/.zshrc (or ~/.bashrc) so it persists across sessions.
#
# Example:
#   ./scripts/deploy-function.sh marketing-advisor

set -euo pipefail

FUNCTION=${1:?Usage: $0 <function-name>}
PROJECT_ID="ytydgldyeygpzmlxvpvb"
SUPABASE="/opt/homebrew/bin/supabase"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "❌ SUPABASE_ACCESS_TOKEN is not set."
  echo "   Run: export SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxx"
  echo "   Or add it to ~/.zshrc to make it permanent."
  exit 1
fi

echo "🚀 Deploying $FUNCTION..."
$SUPABASE functions deploy "$FUNCTION" --project-ref "$PROJECT_ID"

echo "🔓 Patching verify_jwt: false..."
RESULT=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH "https://api.supabase.com/v1/projects/$PROJECT_ID/functions/$FUNCTION" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"verify_jwt": false}')

if [[ "$RESULT" == "200" ]]; then
  echo "✅ Done! $FUNCTION deployed and verify_jwt patched."
else
  echo "⚠️  Deploy succeeded but verify_jwt patch returned HTTP $RESULT"
  echo "   Patch it manually in Supabase Dashboard → Edge Functions → $FUNCTION → Settings"
fi
