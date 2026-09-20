#!/usr/bin/env bash
# Regression suite for block-secret-dumps.sh.
#
#   bash .claude/hooks/test-block-secret-dumps.sh
#
# It lives in a file rather than an inline command on purpose: the test strings
# contain the very patterns the hook blocks, so an inline version blocks itself.
#
# Two failure modes matter equally:
#   - a leak that gets through (a credential lands in the transcript forever)
#   - a false positive (ordinary work blocked, and the guard gets disabled)

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/block-secret-dumps.sh"
pass=0
fail=0

check() {
  local expected="$1" cmd="$2"
  local rc
  rc=$(printf '%s' "$cmd" \
    | python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.stdin.read()}}))' \
    | "$HOOK" >/dev/null 2>&1; echo $?)
  if [[ "$rc" == "$expected" ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$cmd"
  else
    fail=$((fail + 1))
    printf '  FAIL  (rc=%s want=%s) %s\n' "$rc" "$expected" "$cmd"
  fi
}

blocked() { check 2 "$1"; }
allowed() { check 0 "$1"; }

echo "Must be BLOCKED — these would write a credential into the transcript:"
blocked 'env'
blocked 'env | grep SUPA'
blocked 'printenv'
blocked 'printenv SUPABASE_SERVICE_ROLE_KEY'
blocked 'set'
blocked 'export -p'
blocked 'ls && printenv'
blocked 'cat ~/.config/coffeeflow/secrets.env'
blocked 'head -5 .env.local'
blocked 'grep SUPABASE ~/.config/coffeeflow/secrets.env'
blocked 'echo $SUPABASE_SERVICE_ROLE_KEY'
blocked 'echo "$ANTHROPIC_API_KEY"'
blocked 'curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/ops_get_secrets" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -d {}'
blocked 'psql "$SUPABASE_DB_URL" -c "select * from vault.decrypted_secrets"'

echo
echo "Must be ALLOWED — ordinary work, and the supported credential paths:"
allowed 'curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects'
allowed '. scripts/bootstrap-from-db.sh --cache'
allowed './scripts/secrets-doctor.sh --bootstrap'
allowed 'curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/ops_list_secret_names" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -d {}'
allowed 'cat supabase/migrations/20260920_ops_profile_and_vault_reader.sql'
allowed 'cat scripts/secrets.env.example'
allowed 'printf "%s" "$GCP_SERVICE_ACCOUNT_JSON" > /tmp/sa.json'
allowed 'env FOO=bar node script.js'
allowed 'echo ${#SUPABASE_SERVICE_ROLE_KEY}'
allowed 'psql "$SUPABASE_DB_URL" -c "select count(*) from products"'
allowed 'grep -r TELEGRAM_BOT_TOKEN supabase/functions/'
allowed 'git add scripts/secrets.env.example && git commit -m "add secrets template"'
allowed 'printf "%s\n" "store is ~/.config/coffeeflow/secrets.env" >> notes.md && tail -2 notes.md'
allowed 'supabase functions deploy coffee-bot --project-ref ytydgldyeygpzmlxvpvb --no-verify-jwt'

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
