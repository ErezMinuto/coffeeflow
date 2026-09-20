#!/usr/bin/env bash
# Verify the Vault credential path is wired correctly AND locked down.
#
#   ./scripts/verify-vault-access.sh
#
# Most RPCs in this project are deliberately reachable with the anon key. This
# one must not be: ops_get_secrets returns decrypted credentials, and the anon
# key ships in the frontend bundle. This script proves the revoke is in force,
# and fails loudly if it ever stops being.
#
# It lives in a file rather than an inline command because the leak guard in
# .claude/hooks/block-secret-dumps.sh blocks ad-hoc ops_get_secrets calls — and
# it should. Nothing here prints a secret value.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/load-secrets.sh"

for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "❌ $v is not set — run ./scripts/secrets-doctor.sh" >&2
    exit 1
  fi
done

fail=0
RPC="$SUPABASE_URL/rest/v1/rpc/ops_get_secrets"

echo "── the anon key must NOT be able to read credentials ────────────────────"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST "$RPC" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_names":["SUPABASE_ACCESS_TOKEN"]}')
case "$code" in
  401|403|404)
    echo "  anon -> ops_get_secrets    ✓ denied (HTTP $code)" ;;
  200)
    echo "  anon -> ops_get_secrets    ✗ ALLOWED (HTTP 200) — SECURITY REGRESSION"
    echo "     The anon key ships in the frontend. Re-apply the revoke:"
    echo "     revoke all on function public.ops_get_secrets(text[]) from public, anon, authenticated;"
    fail=1 ;;
  *)
    echo "  anon -> ops_get_secrets    ? HTTP $code (unexpected — check by hand)"
    fail=1 ;;
esac

echo
echo "── the service role must be able to ────────────────────────────────────"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST "$RPC" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_names":[]}')
[[ "$code" == 200 ]] \
  && echo "  service_role -> reader     ✓ allowed (HTTP $code)" \
  || { echo "  service_role -> reader     ✗ HTTP $code"; fail=1; }

echo
echo "── what is currently in Vault (names only, never values) ────────────────"
curl -s --max-time 20 \
  -X POST "$SUPABASE_URL/rest/v1/rpc/ops_list_secret_names" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{}' \
| NAMES_FILE="$DIR/secret-names.txt" python3 -c '
import json, os, sys, re

try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit("  could not read the Vault listing")
if isinstance(rows, dict):
    sys.exit("  %s" % rows.get("message", "request rejected"))

in_vault = {r["name"] for r in rows if r.get("name")}
if in_vault:
    for r in sorted(rows, key=lambda r: r["name"]):
        print("  %-28s %s" % (r["name"], (r.get("updated_at") or "")[:19]))
else:
    print("  (empty — nothing has been added to Vault yet)")

wanted, tier = [], None
for line in open(os.environ["NAMES_FILE"]):
    if re.match(r"^#\s*vault\s*$", line):
        tier = "vault"; continue
    if re.match(r"^#\s*bootstrap\s*$", line):
        tier = "boot"; continue
    if line.strip().startswith("#") or not line.strip():
        continue
    if tier == "vault":
        wanted.append(line.split()[0])

missing = [w for w in wanted if w not in in_vault]
extra = sorted(in_vault - set(wanted))
print()
if missing:
    print("  Expected by scripts/secret-names.txt but not in Vault (%d):" % len(missing))
    for m in missing:
        print("    - %s" % m)
if extra:
    print("  In Vault but not in secret-names.txt (add them there to be fetched):")
    for e in extra:
        print("    - %s" % e)
'

echo
echo "── operating profile ────────────────────────────────────────────────────"
curl -s --max-time 20 \
  "$SUPABASE_URL/rest/v1/ops_profile?select=key,value&order=key" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
| python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit("  could not read ops_profile")
if isinstance(rows, dict):
    sys.exit("  %s" % rows.get("message", "request rejected"))
for r in rows:
    print("  %-22s %s" % (r["key"], json.dumps(r["value"], ensure_ascii=False)))
'

echo
[[ "$fail" -eq 0 ]] && echo "Vault access verified." || echo "PROBLEMS FOUND — see above."
exit "$fail"
