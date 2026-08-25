#!/usr/bin/env bash
#
# Deploy the edge functions left stale by PRs #262-#266.
#
# WHY MORE THAN THE OBVIOUS ONES. Supabase BUNDLES a function's imports at deploy
# time, so changing a shared module under seo-agent/ makes every function that
# imports it stale even though its own index.ts never changed. #264 touched
# seo-agent/claude.ts, which is imported by twelve functions — that is why
# strategist-brain, handle-seo-chat and seo-worker-writer are in this list
# despite appearing in none of the PRs.
#
# --no-verify-jwt on EVERY function, deliberately. Crons call these through
# pg_net with no Authorization header, and a deploy RESETS verify_jwt to true —
# which is how a working function starts returning 401 to its own cron and goes
# silently dead. See CLAUDE.md.
#
# Safe to re-run: deploying an unchanged function is a no-op in effect.
#
# Usage:
#   bash scripts/deploy-stale.sh            # deploy all
#   bash scripts/deploy-stale.sh --dry-run  # print the commands only
set -uo pipefail

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
SUPABASE_BIN="${SUPABASE_BIN:-/opt/homebrew/bin/supabase}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# Ordered so the thing most behind prod goes first: stock-update is the only one
# whose live code is now WRONG rather than merely old (it still carries the MFlow
# stock-push removed in #266).
FUNCTIONS=(
  stock-update              # #266 push removal + #260 return-sign
  health-watchdog           # #263 watchdog registry
  organic-worker-instagram  # #262 A/B arm warning
  organic-orchestrator      # #262 reach reporting
  evaluator-tick            # #262 experimentEvaluator (shared)
  seo-worker-techseo        # #264 Gemini slot
  scout-tick                # #264 Gemini slot
  seo-worker-research       # #264 Gemini slot + grounding
  seo-worker-visual         # #264 Gemini slot
  seo-worker-writer         # #264 claude.ts (shared)
  handle-seo-chat           # #264 claude.ts (shared)
  mission-worker            # #264 claude.ts (shared)
  strategist-brain          # #264 claude.ts (shared)
  strategist-evaluator      # #264 claude.ts (shared)
  industry-intelligence-sync # #264 claude.ts (shared)
)

ok=(); failed=()

for fn in "${FUNCTIONS[@]}"; do
  cmd="$SUPABASE_BIN functions deploy $fn --project-ref $PROJECT_REF --no-verify-jwt"
  if [ "$DRY" = "1" ]; then echo "$cmd"; continue; fi

  printf '\n=== %s ===\n' "$fn"
  if $cmd; then ok+=("$fn"); else failed+=("$fn"); fi
done

[ "$DRY" = "1" ] && exit 0

printf '\n──────────────────────────────\n'
printf 'deployed: %d\n' "${#ok[@]}"
if [ "${#failed[@]}" -gt 0 ]; then
  printf 'FAILED:   %s\n' "${failed[*]}"
  printf '\nRe-run for just those, then check verify_jwt is false on them.\n'
  exit 1
fi

printf 'all clean.\n'
printf '\nNOTE: Gemini stays OFF. No MODEL_* secret is set, so every slot still\n'
printf 'resolves to its Claude default. Run scripts/gemini-smoke.ts before\n'
printf 'setting one.\n'
