#!/usr/bin/env bash
# claim-signal.sh — atomically claim ONE approved bug_report for the fixer agent.
#
# Resolves the target signal (an explicit id, else the oldest approved bug_report),
# then flips it approved -> building with a PostgREST filter guarded on the current
# status, so two concurrent runs can never double-claim the same row. On success it
# writes the full signal row to ./fixer-signal.json (the agent's input) and exports
# `signal_id` / `claimed` to $GITHUB_OUTPUT.
#
# This is deterministic bookkeeping ON PURPOSE — the LLM never owns status writes.
#
# Env:
#   SUPABASE_URL                https://<ref>.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY   eyJ... (JWT; sb_secret_* breaks PostgREST writes)
#   SIGNAL_ID                   (optional) a specific strategist_signals.id to claim
#
# Output (to $GITHUB_OUTPUT when present, else stdout):
#   claimed=true|false
#   signal_id=<uuid|empty>
set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"

REST="${SUPABASE_URL%/}/rest/v1/strategist_signals"
WORKER_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
SIGNAL_ID="${SIGNAL_ID:-}"

# Tiny helper so we never echo the key into logs.
auth=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")

emit() { # key=value -> GITHUB_OUTPUT (or stdout when running locally)
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1" >> "$GITHUB_OUTPUT"; else echo "$1"; fi
}

bail_unclaimed() {
  echo "claim-signal: nothing to claim${1:+ ($1)}" >&2
  emit "claimed=false"
  emit "signal_id="
  exit 0
}

# 1. Resolve the target id if not given: oldest approved bug_report.
if [[ -z "$SIGNAL_ID" ]]; then
  picked=$(curl -fsS "${auth[@]}" \
    "${REST}?kind=eq.bug_report&status=eq.approved&select=id&order=created_at.asc&limit=1")
  SIGNAL_ID=$(echo "$picked" | jq -r '.[0].id // empty')
  [[ -z "$SIGNAL_ID" ]] && bail_unclaimed "no approved bug_report in queue"
fi

# 2. Atomic claim: only succeeds while the row is still an approved bug_report.
#    An empty representation array means we lost the race / wrong state / wrong kind.
claimed=$(curl -fsS -X PATCH "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  "${REST}?id=eq.${SIGNAL_ID}&status=eq.approved&kind=eq.bug_report" \
  -d "$(jq -nc --arg w "$WORKER_ID" '{status:"building", worker_id:$w, updated_at:(now|todateiso8601)}')")

count=$(echo "$claimed" | jq 'length')
[[ "$count" == "0" ]] && bail_unclaimed "signal ${SIGNAL_ID} was not in approved/bug_report state"

# 3. Persist the claimed row for the agent to read, and report success.
echo "$claimed" | jq '.[0]' > fixer-signal.json
echo "claim-signal: claimed ${SIGNAL_ID} (worker ${WORKER_ID})" >&2
emit "claimed=true"
emit "signal_id=${SIGNAL_ID}"
