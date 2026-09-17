#!/usr/bin/env bash
# claim-task.sh — atomically claim ONE pending reel_render task from seo_tasks.
#
# Same pattern as scripts/fixer/claim-signal.sh: the PATCH is guarded on
# status=pending, so two concurrent workflow runs can never render the same task.
# On success it writes the task's brief_data to ./reel-brief.json and exports
# `claimed`, `task_id`, `woo_id` to $GITHUB_OUTPUT.
#
# Env:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (eyJ... JWT; sb_secret_* breaks PostgREST writes)
#   TASK_ID   the seo_tasks.id to claim
set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
: "${TASK_ID:?TASK_ID is required}"

REST="${SUPABASE_URL%/}/rest/v1/seo_tasks"
auth=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")
emit() { if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1" >> "$GITHUB_OUTPUT"; else echo "$1"; fi; }

claimed=$(curl -fsS -X PATCH "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  "${REST}?id=eq.${TASK_ID}&task_type=eq.reel_render&status=eq.pending" \
  -d "$(jq -nc --arg w "gh-${GITHUB_RUN_ID:-local}" \
        '{status:"processing", worker_id:$w, started_at:(now|todateiso8601), updated_at:(now|todateiso8601)}')")

if [[ "$(echo "$claimed" | jq 'length')" == "0" ]]; then
  echo "claim-task: ${TASK_ID} is not a pending reel_render task" >&2
  emit "claimed=false"
  exit 0
fi

echo "$claimed" | jq '.[0].brief_data' > reel-brief.json
woo_id=$(jq -r '.woo_id // empty' reel-brief.json)
if [[ -z "$woo_id" ]]; then
  echo "claim-task: brief_data.woo_id missing" >&2
fi
echo "claim-task: claimed ${TASK_ID} (woo_id=${woo_id:-none})" >&2
emit "claimed=true"
emit "task_id=${TASK_ID}"
emit "woo_id=${woo_id}"
