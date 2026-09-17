#!/usr/bin/env bash
# finalize-task.sh — upload the rendered reel and write the task's terminal status.
#
# Runs as the workflow's last step (if: always()). If ./reel.mp4 and ./facts.json
# exist, it uploads the MP4 to the public `marketing` bucket (ig-reels/) and marks
# the task completed with review_required=true, so it waits in the dashboard queue
# for a human to approve. Anything missing means the render failed -> status failed.
# Guarded on status=processing, so a re-run never clobbers a later human change.
#
# Env:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   TASK_ID   the claimed task (empty => nothing claimed => no-op)
#   RENDER_ERROR  optional short reason when an earlier step failed
set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
TASK_ID="${TASK_ID:-}"
[[ -z "$TASK_ID" ]] && { echo "finalize-task: nothing claimed" >&2; exit 0; }

BASE="${SUPABASE_URL%/}"
auth=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

patch_task() {
  curl -fsS -X PATCH "${auth[@]}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    "${BASE}/rest/v1/seo_tasks?id=eq.${TASK_ID}&status=eq.processing" \
    -d "$1"
}

if [[ -s reel.mp4 && -s facts.json ]]; then
  object="ig-reels/reel_${TASK_ID}.mp4"
  curl -fsS -X POST "${auth[@]}" \
    -H "Content-Type: video/mp4" \
    -H "x-upsert: true" \
    --data-binary @reel.mp4 \
    "${BASE}/storage/v1/object/marketing/${object}" > /dev/null
  video_url="${BASE}/storage/v1/object/public/marketing/${object}"

  # Draft caption from verified facts only; the reviewer edits it before publishing.
  payload=$(jq -nc --arg v "$video_url" --arg run "$run_url" --slurpfile f facts.json '
    ($f[0]) as $x
    | ([ ([$x.titleEn, $x.subtitleEn] | map(select(. != null)) | join(" ")),
         (if ($x.notes | length) > 0 then ($x.notes | join(" · ")) else empty end),
         ([ (if $x.grams then "\($x.grams) גרם" else empty end), "₪\($x.price)", $x.detailLine ]
            | map(select(. != null)) | join(" · ")),
         "minuto.co.il"
       ] | join("\n")) as $caption
    | {status:"completed", completed_at:(now|todateiso8601), updated_at:(now|todateiso8601),
       result_data:{media_type:"reel", video_url:$v, caption:$caption, facts:$x,
                    review_required:true, render_run_url:$run}}')
  resp=$(patch_task "$payload")
  outcome="completed (${video_url})"
else
  reason="${RENDER_ERROR:-render produced no video; see ${run_url}}"
  resp=$(patch_task "$(jq -nc --arg e "$reason" '{status:"failed", error_msg:$e, updated_at:(now|todateiso8601)}')")
  outcome="failed (${reason})"
fi

if [[ "$(echo "$resp" | jq 'length')" == "0" ]]; then
  echo "finalize-task: ${TASK_ID} was not processing; no change" >&2
else
  echo "finalize-task: ${TASK_ID} -> ${outcome}" >&2
fi
