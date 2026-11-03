#!/usr/bin/env bash
# Self-test for qa_review.py: every check must FAIL on a change that breaks its
# rule, and a harmless change must pass. Builds each case as a real commit in a
# throwaway detached worktree, so the checker sees exactly what a PR would.
#
#   bash scripts/ci/qa_review_test.sh
#
# Offline, no secrets. The "secrets" fixtures are fake values shaped like real
# ones (they are assembled at runtime so this file itself never matches).
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
WT="$(mktemp -d)/qa-review-test"
git -C "$ROOT" worktree add -q --detach "$WT" HEAD
trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1' EXIT
cd "$WT" || exit 1
git config user.email qa@test.local; git config user.name qa-test
# Test the checker from the CURRENT tree (it may be uncommitted while iterating).
cp "$ROOT/scripts/ci/qa_review.py" scripts/ci/qa_review.py
git add -A && git commit -qm "checker under test" --allow-empty
BASE="$(git rev-parse HEAD)"

failures=0
# case <name> <expect: pass|fail> <check> <setup-command…>
case_() {
  local name="$1" expect="$2" check="$3"; shift 3
  git reset -q --hard "$BASE"
  eval "$@"
  git add -A && git commit -qm "$name" --allow-empty
  out="$(python3 scripts/ci/qa_review.py "$BASE" HEAD 2>&1)"; code=$?
  if [ "$expect" = fail ]; then
    if [ $code -eq 1 ] && echo "$out" | grep -qE "^\| ❌ \| $check \|"; then echo "✅ $name"; else echo "❌ $name (expected a $check FAIL, exit=$code)"; echo "$out" | sed 's/^/     /' | head -20; failures=$((failures+1)); fi
  elif [ "$expect" = warn ]; then
    if [ $code -eq 0 ] && echo "$out" | grep -qE "^\| ⚠️ \| $check \|"; then echo "✅ $name"; else echo "❌ $name (expected a $check WARN and exit 0, exit=$code)"; echo "$out" | sed 's/^/     /' | head -20; failures=$((failures+1)); fi
  else
    if [ $code -eq 0 ] && ! echo "$out" | grep -qE "^\| ❌"; then echo "✅ $name"; else echo "❌ $name (expected pass, exit=$code)"; echo "$out" | sed 's/^/     /' | head -20; failures=$((failures+1)); fi
  fi
}

F=supabase/functions/coffee-bot/index.ts

# ── jwt ──
case_ "removing a bot from NO_VERIFY_JWT blocks" fail jwt \
  "sed -i.bak 's/^NO_VERIFY_JWT=\"coffee-bot /NO_VERIFY_JWT=\"/' scripts/deploy-functions.sh && rm scripts/deploy-functions.sh.bak"
case_ "deploying a NO_VERIFY_JWT fn without the flag blocks" fail jwt \
  "printf '%s\n' 'supabase functions deploy telegram-bot --project-ref x' > scripts/redeploy.sh"
case_ "deploying it WITH the flag passes" pass jwt \
  "printf '%s\n' 'supabase functions deploy telegram-bot --project-ref x --no-verify-jwt' > scripts/redeploy.sh"

# ── pin ──
case_ "an unpinned supabase-js@2 in an affected function blocks" fail pin \
  "sed -i.bak 's#supabase-js@2.116.0#supabase-js@2#' $F && rm $F.bak"
case_ "a different exact version blocks too" fail pin \
  "sed -i.bak 's#supabase-js@2.116.0#supabase-js@2.117.0#' $F && rm $F.bak"
case_ "a pinned import passes" pass pin "echo '// touch' >> $F"

# ── filterByUser ──
case_ "a bare useSupabaseData on a shared table blocks" fail filterByUser \
  "printf '%s\n' \"export const X = () => useSupabaseData('products');\" > src/lib/qa_fixture.js"
case_ "filterByUser: true on a shared table blocks" fail filterByUser \
  "printf '%s\n' \"export const X = () => useSupabaseData('roasts', { filterByUser: true });\" > src/lib/qa_fixture.js"
case_ "filterByUser: false on a shared table passes" pass filterByUser \
  "printf '%s\n' \"export const X = () => useSupabaseData('roasts', { filterByUser: false });\" > src/lib/qa_fixture.js"
case_ "per-user cost_settings with the default passes" pass filterByUser \
  "printf '%s\n' \"export const X = () => useSupabaseData('cost_settings');\" > src/lib/qa_fixture.js"

# ── secrets ── (values assembled here so this file never contains a match)
ANT="sk-ant-""api03-$(printf 'a1B2c3D4%.0s' 1 2 3 4)"
JWT="eyJ""hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ""yb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.$(printf 'Xy9%.0s' 1 2 3 4 5 6 7 8)"
case_ "a literal Anthropic key blocks" fail secrets "printf '%s\n' \"const k = '$ANT'\" > $F.qa.ts"
case_ "a literal service-role JWT blocks" fail secrets "printf '%s\n' \"const k = '$JWT'\" > src/lib/qa_fixture.js"
case_ "logging a key blocks" fail secrets \
  "printf '%s\n' 'console.log(\`using \${SERVICE_ROLE_KEY}\`)' > $F.qa.ts"
case_ "logging a key's length passes" pass secrets \
  "printf '%s\n' 'console.log(\`key len \${SERVICE_ROLE_KEY.length}\`)' > $F.qa.ts"
case_ "a literal token in a URL blocks" fail secrets \
  "printf '%s\n' \"fetch('https://graph.facebook.com/me?access_token=EAAB9xk2LmQ77abc')\" > $F.qa.ts"
case_ "an interpolated token in a URL only warns" warn secrets \
  "printf '%s\n' 'fetch(\`https://graph.facebook.com/me?access_token=\${token}\`)' > $F.qa.ts"
case_ "a hard-coded random constant blocks" fail secrets \
  "printf '%s\n' \"const API_KEY = 'f8Kd93LmQ2x7Zp41Vb6nRt0w'\" > $F.qa.ts"
case_ "a constant that is a field name passes" pass secrets \
  "printf '%s\n' \"const META_KEY = '_minuto_faq_published_flag'\" > $F.qa.ts"
case_ "qa-allow opts a line out" pass secrets \
  "printf '%s\n' \"const k = '$JWT' // qa-allow: secrets — public anon key\" > src/lib/qa_fixture.js"

# ── prompt ──
case_ "a hard-coded ONLY override in a retry path blocks" fail prompt "cat > supabase/functions/coffee-bot/qa_prompt.ts <<'EOF'
export function stripForRetry(brief: string): string {
  return brief + '\nThe image must show ONLY the espresso machine and the pull, nothing else.'
}
EOF
echo \"import './qa_prompt.ts'\" >> $F"
case_ "the same sentence outside a retry path only warns" warn prompt "cat > supabase/functions/coffee-bot/qa_prompt.ts <<'EOF'
export function machineHeroBrief(): string {
  return 'The image must show ONLY the espresso machine and the pull, nothing else.'
}
EOF"
case_ "a hunk that forbids and requires the same subject warns" warn prompt "cat > supabase/functions/coffee-bot/qa_prompt.ts <<'EOF'
export const BRIEF = [
  'No coffee bags anywhere in frame.',
  'The shot must show the coffee bag front and centre.',
].join(' ')
EOF"
case_ "an ordinary prompt edit passes" pass prompt "cat > supabase/functions/coffee-bot/qa_prompt.ts <<'EOF'
export const BRIEF = 'Morning light on a slate counter. No human hands. Must show the AeroPress.'
EOF"

echo
[ $failures -eq 0 ] && echo "all good" || { echo "$failures failing"; exit 1; }
