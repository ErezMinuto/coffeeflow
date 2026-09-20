#!/usr/bin/env bash
# Put a credential into Supabase Vault. One command, hidden prompt, no editor.
#
#   ./scripts/set-secret.sh SUPABASE_DB_URL
#   ./scripts/set-secret.sh GEMINI_API_KEY
#   ./scripts/set-secret.sh --list          # what is in Vault (names only)
#   ./scripts/set-secret.sh --delete NAME
#
# The value is typed at a hidden prompt and goes straight to the database. It is
# never written to a file, never echoed, and never reaches your shell history or
# this conversation. You are asked to type it twice, because a mistyped password
# stored silently is worse than no password at all.
#
# Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (./scripts/secrets-doctor.sh)
# and the ops_set_secret function (supabase/migrations/20260920_ops_set_secret.sql).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/load-secrets.sh"

for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "❌ $v is not set — run ./scripts/secrets-doctor.sh" >&2
    exit 1
  fi
done

api() { # rpc_name json_body
  curl -s --max-time 30 \
    -X POST "$SUPABASE_URL/rest/v1/rpc/$1" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    --data-binary @-
}

case "${1:-}" in
  --list|"")
    echo "In Vault (names only):"
    printf '{}' | api ops_list_secret_names | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit("  could not read the listing")
if isinstance(rows, dict):
    sys.exit("  %s" % rows.get("message", "request rejected"))
if not rows:
    print("  (empty)")
for r in sorted(rows, key=lambda r: r["name"]):
    print("  %-28s %s" % (r["name"], (r.get("updated_at") or "")[:19]))
'
    echo
    echo "Add one with:  ./scripts/set-secret.sh <NAME>"
    exit 0
    ;;
  --delete)
    NAME="${2:?usage: $0 --delete <NAME>}"
    read -r -p "Delete '$NAME' from Vault? [y/N] " confirm
    [[ "$confirm" == [yY] ]] || { echo "cancelled"; exit 1; }
    printf '%s' "$(python3 -c "import json,sys;print(json.dumps({'p_name': sys.argv[1]}))" "$NAME")" \
      | api ops_delete_secret | tr -d '"'
    echo
    exit 0
    ;;
esac

NAME="$1"

if ! grep -qx "$NAME" "$DIR/secret-names.txt"; then
  echo "⚠  '$NAME' is not listed in scripts/secret-names.txt."
  echo "   Nothing will fetch it automatically until you add it there."
  read -r -p "   Store it anyway? [y/N] " confirm
  [[ "$confirm" == [yY] ]] || exit 1
fi

# SUPABASE_DB_URL is the one people get wrong, so build it from the password.
if [[ "$NAME" == "SUPABASE_DB_URL" ]]; then
  ref="${SUPABASE_URL#https://}"; ref="${ref%%.*}"
  echo "Building the Postgres connection string for project $ref."
  echo "Paste the full URI if you have it, or just press Enter to be asked for"
  echo "the password only (direct connection, db.$ref.supabase.co:5432)."
  read -r -s -p "  Full URI (or Enter): " full; echo
  if [[ -n "$full" ]]; then
    value="$full"
    read -r -s -p "  Repeat it: " again; echo
  else
    read -r -s -p "  Database password: " pw; echo
    read -r -s -p "  Repeat password:   " pw2; echo
    if [[ "$pw" != "$pw2" ]]; then
      echo "❌ They do not match. Nothing stored." >&2
      exit 1
    fi
    value="postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres"
    again="$value"
  fi
else
  read -r -s -p "Value for $NAME: " value; echo
  read -r -s -p "Repeat it:       " again; echo
fi

if [[ -z "$value" ]]; then
  echo "❌ Empty value. Nothing stored." >&2
  exit 1
fi
if [[ "$value" != "$again" ]]; then
  echo "❌ They do not match. Nothing stored." >&2
  exit 1
fi

result=$(NAME="$NAME" VALUE="$value" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "p_name": os.environ["NAME"],
    "p_secret": os.environ["VALUE"],
    "p_description": "set by scripts/set-secret.sh",
}))
' | api ops_set_secret)

echo "$result" | NAME="$NAME" EXPECTED_LEN="${#value}" python3 -c '
import json, os, sys
name = os.environ["NAME"]
raw = sys.stdin.read().strip()
try:
    out = json.loads(raw)
except Exception:
    sys.exit("could not parse the response")
if isinstance(out, dict):
    sys.exit("%s" % out.get("message", "request rejected"))
print("%s in Vault: %s (%s characters)" % (name, out, os.environ["EXPECTED_LEN"]))
' || exit 1

# Prove it round-trips, by length only — the value is never shown.
printf '%s' "$(NAME="$NAME" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({"p_names": [os.environ["NAME"]]}))
')" | api ops_get_secrets | NAME="$NAME" EXPECTED_LEN="${#value}" python3 -c '
import json, os, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit("  read-back failed: could not parse the response")
if isinstance(rows, dict):
    sys.exit("  read-back failed: %s" % rows.get("message", "request rejected"))
want = int(os.environ["EXPECTED_LEN"])
for r in rows:
    if r.get("name") == os.environ["NAME"]:
        got = len(r.get("secret") or "")
        print("  read-back ✓ (%d characters, matches)" % got if got == want
              else "  read-back ✗ stored %d characters, expected %d" % (got, want))
        break
else:
    print("  read-back ✗ not found")
'

echo
echo "Any session can now fetch it with: . scripts/bootstrap-from-db.sh"
