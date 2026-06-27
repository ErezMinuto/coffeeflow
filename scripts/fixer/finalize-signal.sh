#!/usr/bin/env bash
# finalize-signal.sh — write the fixer's terminal status back to strategist_signals.
#
# Runs as the workflow's LAST step (if: always()), so it must tolerate every exit
# path of the agent: a clean fix, a deliberate bail, or a crashed Claude step. It
# reads the agent's ./fixer-result.json contract and flips the claimed row:
#   { "outcome": "fixed",        "pr_url": "...", "note": "..." } -> shipped (+pr_url)
#   { "outcome": "needs_human",  "note": "..." }                  -> needs_human (+note)
# A missing/garbled result file (agent crashed) is treated as needs_human so a
# claimed signal never gets stranded in 'building'.
#
# The UPDATE is guarded on status=eq.building, so re-running finalize is a no-op and
# it never clobbers a status the human has since changed.
#
# Env:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   SIGNAL_ID   the row claimed earlier (empty => nothing was claimed => no-op)
set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"

SIGNAL_ID="${SIGNAL_ID:-}"
if [[ -z "$SIGNAL_ID" ]]; then
  echo "finalize-signal: no signal was claimed; nothing to finalize" >&2
  exit 0
fi

REST="${SUPABASE_URL%/}/rest/v1/strategist_signals"
auth=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")

# Parse the agent's result contract, defaulting to needs_human on any problem.
outcome="needs_human"
pr_url=""
note="Fixer produced no result file — the Claude step likely failed. Check the GitHub Actions run logs."
if [[ -f fixer-result.json ]] && jq -e . fixer-result.json >/dev/null 2>&1; then
  outcome=$(jq -r '.outcome // "needs_human"' fixer-result.json)
  pr_url=$(jq -r '.pr_url  // ""' fixer-result.json)
  note=$(jq -r '.note    // ""' fixer-result.json)
fi

if [[ "$outcome" == "fixed" && -n "$pr_url" ]]; then
  status="shipped"
else
  status="needs_human"
  [[ -z "$note" ]] && note="Fixer could not produce a code fix (no reason recorded)."
fi

payload=$(jq -nc --arg s "$status" --arg p "$pr_url" --arg n "$note" \
  '{status:$s, updated_at:(now|todateiso8601)}
   + (if $p == "" then {} else {pr_url:$p} end)
   + (if $n == "" then {} else {fixer_note:$n} end)')

resp=$(curl -fsS -X PATCH "${auth[@]}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  "${REST}?id=eq.${SIGNAL_ID}&status=eq.building" \
  -d "$payload")

if [[ "$(echo "$resp" | jq 'length')" == "0" ]]; then
  echo "finalize-signal: ${SIGNAL_ID} was not in 'building' (already finalized?) — no change" >&2
else
  echo "finalize-signal: ${SIGNAL_ID} -> ${status}${pr_url:+ (${pr_url})}" >&2
fi
