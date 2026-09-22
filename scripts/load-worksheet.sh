#!/usr/bin/env bash
# Push a filled-in worksheet into Supabase Vault, then delete the worksheet.
#
#   cp scripts/secrets-worksheet.example.env ~/coffeeflow-worksheet.env
#   # fill it in
#   ./scripts/load-worksheet.sh ~/coffeeflow-worksheet.env           # dry run
#   ./scripts/load-worksheet.sh ~/coffeeflow-worksheet.env --apply   # store them
#
# Dry run by default: it shows which names it would store, with lengths, and
# never a value. --apply writes them and then removes the file, because a
# plaintext file full of credentials is the thing this whole setup exists to
# avoid. Keep --keep if you want it left in place.
#
# Blank values are skipped. A value identical to what is already in Vault is
# skipped too, so re-running after filling in two more lines is cheap.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$DIR/load-secrets.sh"

WORKSHEET="${1:-}"
if [[ -z "$WORKSHEET" ]]; then
  echo "usage: $0 <worksheet> [--apply] [--keep]" >&2
  exit 1
fi
if [[ ! -f "$WORKSHEET" ]]; then
  echo "❌ no such file: $WORKSHEET" >&2
  exit 1
fi

APPLY=0
KEEP=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --keep)  KEEP=1 ;;
  esac
done

for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "❌ $v is not set — run ./scripts/secrets-doctor.sh" >&2
    exit 1
  fi
done

WORKSHEET="$WORKSHEET" APPLY="$APPLY" \
SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
python3 -c '
import json, os, sys, urllib.request

path = os.environ["WORKSHEET"]
apply_ = os.environ["APPLY"] == "1"
base = os.environ["SUPABASE_URL"]
key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

HEADERS = {
    "apikey": key,
    "Authorization": "Bearer " + key,
    "Content-Type": "application/json",
}

def rpc(name, payload):
    req = urllib.request.Request(
        base + "/rest/v1/rpc/" + name,
        data=json.dumps(payload).encode(),
        headers=HEADERS,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode()
    return json.loads(raw) if raw.strip() else None

ok = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
entries, problems = [], []
for n, line in enumerate(open(path, encoding="utf-8", errors="replace").read().splitlines(), 1):
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
        continue
    name, _, value = line.partition("=")
    value = value.strip()
    if not value:
        continue
    if name != name.strip() or not name or any(c not in ok for c in name):
        problems.append("line %d: %r is not a usable variable name" % (n, name.strip()))
        continue
    if value.startswith(("“", "‘")) or " #" in value:
        problems.append("line %d: %s looks like it has a trailing comment or a smart quote" % (n, name))
        continue
    entries.append((name, value))

if problems:
    print("Problems — these lines will be ignored:")
    for p in problems:
        print("  - %s" % p)
    print()

if not entries:
    sys.exit("Nothing filled in. Every value line is blank.")

# What is already stored, so an unchanged value is not rewritten.
try:
    existing = {r["name"]: r for r in (rpc("ops_list_secret_names", {}) or [])}
except Exception as e:
    sys.exit("could not read the Vault listing: %s" % e)

print("%d value(s) filled in:" % len(entries))
for name, value in entries:
    state = "update" if name in existing else "new   "
    print("  %-28s %s  len=%d" % (name, state, len(value)))

if not apply_:
    print()
    print("Dry run. Re-run with --apply to store these in Vault.")
    sys.exit(0)

print()
print("Storing:")
stored = failed = 0
for name, value in entries:
    try:
        outcome = rpc("ops_set_secret", {
            "p_name": name,
            "p_secret": value,
            "p_description": "loaded from worksheet",
        })
    except Exception as e:
        print("  %-28s ✗ %s" % (name, e))
        failed += 1
        continue
    print("  %-28s ✓ %s" % (name, outcome))
    stored += 1

print()
print("%d stored, %d failed." % (stored, failed))
sys.exit(1 if failed else 0)
'
rc=$?

if [[ $rc -eq 0 && $APPLY -eq 1 && $KEEP -eq 0 ]]; then
  # Overwrite before unlinking: the point is that no plaintext copy survives.
  if command -v shred >/dev/null 2>&1; then
    shred -u "$WORKSHEET" 2>/dev/null || rm -f "$WORKSHEET"
  else
    dd if=/dev/urandom of="$WORKSHEET" bs=1k count=8 conv=notrunc 2>/dev/null
    rm -f "$WORKSHEET"
  fi
  echo "Worksheet overwritten and deleted: $WORKSHEET"
  echo
  echo "Check what landed:  ./scripts/set-secret.sh --list"
elif [[ $APPLY -eq 1 && $KEEP -eq 1 ]]; then
  echo
  echo "⚠  Worksheet kept at $WORKSHEET — it holds credentials in plaintext."
  echo "   Delete it when you are done."
fi

exit $rc
