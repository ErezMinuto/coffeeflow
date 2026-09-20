#!/usr/bin/env bash
# Fill the local store's Supabase keys from the Management API, so nobody has to
# copy them out of the dashboard by hand.
#
#   ./scripts/fetch-supabase-keys.sh            # prod
#   ./scripts/fetch-supabase-keys.sh <ref>      # another project
#
# SUPABASE_ACCESS_TOKEN (sbp_…) already authorizes this, so the one credential a
# developer types by hand bootstraps the rest. Fetched values are written straight
# into ~/.config/coffeeflow/secrets.env (chmod 600) and are never printed — the
# script reports names, lengths and a 3-character prefix only.
#
# What it CANNOT get, by design of the platform:
#   - SUPABASE_DB_URL — the database password is not readable, only resettable.
#     Copy it from Project Settings -> Database, or reset it there.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_REF="${1:-ytydgldyeygpzmlxvpvb}"
STORE="${COFFEEFLOW_SECRETS_FILE:-$HOME/.config/coffeeflow/secrets.env}"

# shellcheck source=/dev/null
. "$SCRIPT_DIR/load-secrets.sh"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "❌ SUPABASE_ACCESS_TOKEN is not set — it is what authorizes this." >&2
  echo "   It normally comes from ~/.zshenv or the store." >&2
  exit 1
fi

if [[ ! -f "$STORE" ]]; then
  echo "❌ $STORE does not exist. Run ./scripts/install-secrets.sh first." >&2
  exit 1
fi

# reveal=true is required on newer projects; older ones ignore it.
# SUPABASE_API_BASE exists so the parsing and file handling can be exercised
# against a mock, without any real credential being fetched.
API_BASE="${SUPABASE_API_BASE:-https://api.supabase.com}"

response=$(curl -s --max-time 30 \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "$API_BASE/v1/projects/$PROJECT_REF/api-keys?reveal=true")

STORE="$STORE" PROJECT_REF="$PROJECT_REF" python3 -c '
import json, os, sys

store = os.environ["STORE"]
ref = os.environ["PROJECT_REF"]
raw = sys.stdin.read()

try:
    rows = json.loads(raw)
except Exception:
    sys.exit("could not parse the Management API response")

if isinstance(rows, dict):
    sys.exit("Management API: %s" % rows.get("message", "request rejected"))

wanted = {"anon": "SUPABASE_ANON_KEY", "service_role": "SUPABASE_SERVICE_ROLE_KEY"}
found = {"SUPABASE_URL": "https://%s.supabase.co" % ref}
for r in rows:
    var = wanted.get(r.get("name"))
    key = r.get("api_key")
    if var and key:
        found[var] = key

missing = [v for v in wanted.values() if v not in found]

# Replace existing lines for these names rather than appending duplicates.
with open(store) as fh:
    lines = fh.read().splitlines()

kept = [l for l in lines if l.split("=", 1)[0].strip() not in found]

fd = os.open(store, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as fh:
    fh.write("\n".join(kept).rstrip("\n") + "\n")
    for var in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        if var in found:
            fh.write("%s=%s\n" % (var, found[var]))
os.chmod(store, 0o600)

print("Written to %s (chmod 600), values not shown:" % store)
for var in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
    if var in found:
        v = found[var]
        print("  %-28s len=%-4s prefix=%s…" % (var, len(v), v[:3]))

if missing:
    print()
    print("Not returned by the API: %s" % ", ".join(missing))
    print("Newer projects may expose these as publishable/secret keys instead.")

srk = found.get("SUPABASE_SERVICE_ROLE_KEY", "")
if srk and not srk.startswith("eyJ"):
    print()
    print("⚠  The service role key is not the eyJ… JWT format.")
    print("   The sb_secret_… format breaks PostgREST UPDATE/INSERT (see CLAUDE.md).")
' <<< "$response"

rc=$?
echo
if [[ $rc -eq 0 ]]; then
  echo "Still needed by hand: SUPABASE_DB_URL (password is not readable via any API)."
  echo "Check what is loaded with: ./scripts/secrets-doctor.sh"
fi
exit $rc
