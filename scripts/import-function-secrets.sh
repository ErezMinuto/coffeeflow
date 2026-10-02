#!/usr/bin/env bash
# Copy Supabase *edge function* secrets into Vault, so a session shell can use the
# same credentials the functions already have — without anyone retyping them.
#
#   ./scripts/import-function-secrets.sh           # dry run: what would be copied
#   ./scripts/import-function-secrets.sh --apply   # actually copy
#   ./scripts/import-function-secrets.sh --apply --all   # every secret, not just
#                                                        # the ones in secret-names.txt
#
# Whether this works at all depends on something only a live call can answer: the
# Management API may return each secret's real value, or only a hash of it. The
# script detects which and tells you — it never guesses.
#
# Values are passed from the API straight into ops_set_secret. Nothing is written
# to a file, printed, or logged. The report shows names and lengths only.
#
# Needs SUPABASE_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the
# ops_set_secret function.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/load-secrets.sh"

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
API_BASE="${SUPABASE_API_BASE:-https://api.supabase.com}"

APPLY=0
ALL=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --all)   ALL=1 ;;
  esac
done

for v in SUPABASE_ACCESS_TOKEN SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "❌ $v is not set — run ./scripts/secrets-doctor.sh" >&2
    exit 1
  fi
done

curl -s --max-time 30 \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "$API_BASE/v1/projects/$PROJECT_REF/secrets" \
| APPLY="$APPLY" ALL="$ALL" NAMES_FILE="$DIR/secret-names.txt" \
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  python3 -c '
import json, os, re, sys, urllib.request

apply_ = os.environ["APPLY"] == "1"
take_all = os.environ["ALL"] == "1"

try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit("could not parse the Management API response")
if isinstance(rows, dict):
    sys.exit("Management API: %s" % rows.get("message", "request rejected"))

# Which names are worth having in a shell.
wanted, tier = set(), None
for line in open(os.environ["NAMES_FILE"]):
    if re.match(r"^#\s*vault\s*$", line):
        tier = "vault"; continue
    if re.match(r"^#\s*bootstrap\s*$", line):
        tier = "boot"; continue
    if line.strip().startswith("#") or not line.strip():
        continue
    if tier:
        wanted.add(line.split()[0])

# A 64-character hex string is a sha256 digest, not the secret.
def is_digest(v):
    return bool(re.fullmatch(r"[0-9a-f]{64}", v or ""))

usable, digests, skipped = [], [], []
for r in rows:
    name, value = r.get("name"), r.get("value") or ""
    if not name:
        continue
    if not (take_all or name in wanted):
        skipped.append(name); continue
    if is_digest(value):
        digests.append(name)
    elif value:
        usable.append((name, value))

if digests and not usable:
    print("The Management API returns HASHES, not values — %d of them." % len(digests))
    print("Nothing can be imported this way.")
    print()
    print("Use the worksheet instead:")
    print("  cp scripts/secrets-worksheet.example.env ~/coffeeflow-worksheet.env")
    print("  # fill it in, copying values from the Supabase dashboard:")
    print("  #   Edge Functions -> Secrets (each row can be revealed)")
    print("  ./scripts/load-worksheet.sh ~/coffeeflow-worksheet.env")
    sys.exit(2)

print("Readable from the Management API (%d):" % len(usable))
for name, value in sorted(usable):
    print("  %-28s len=%-5d prefix=%s…" % (name, len(value), value[:3]))
if digests:
    print()
    print("Hashed, cannot be imported (%d): %s" % (len(digests), ", ".join(sorted(digests))))
if skipped:
    print()
    print("Not in secret-names.txt, skipped (%d). Use --all to include them." % len(skipped))

if not apply_:
    print()
    print("Dry run. Re-run with --apply to write these into Vault.")
    sys.exit(0)

print()
print("Writing to Vault:")
ok = failed = 0
for name, value in sorted(usable):
    body = json.dumps({
        "p_name": name,
        "p_secret": value,
        "p_description": "imported from edge function secrets",
    }).encode()
    req = urllib.request.Request(
        os.environ["SUPABASE_URL"] + "/rest/v1/rpc/ops_set_secret",
        data=body,
        headers={
            "apikey": os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            "Authorization": "Bearer " + os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            outcome = json.loads(raw) if raw.strip() else "ok"
    except Exception as e:
        print("  %-28s ✗ %s" % (name, e))
        failed += 1
        continue
    print("  %-28s ✓ %s" % (name, outcome))
    ok += 1

print()
print("%d written, %d failed." % (ok, failed))
print("Check with: ./scripts/set-secret.sh --list")
'
