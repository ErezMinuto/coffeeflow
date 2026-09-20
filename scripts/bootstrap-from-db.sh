#!/usr/bin/env bash
# Pull credentials from Supabase Vault into this shell's environment.
#
#   . scripts/bootstrap-from-db.sh          # fetch secrets, print the ops profile
#   . scripts/bootstrap-from-db.sh --quiet  # fetch secrets only
#   . scripts/bootstrap-from-db.sh --cache  # also write them to the local store,
#                                           # so later commands need no network
#
# This is what makes a task sent from a phone work: a Claude Code cloud session
# can see nothing on the Mac, so it is configured with exactly two values —
#
#     SUPABASE_URL
#     SUPABASE_SERVICE_ROLE_KEY
#
# — and fetches every other credential from Vault through public.ops_get_secrets
# (service_role only; see supabase/migrations/20260920_ops_profile_and_vault_reader.sql).
#
# Values move from the HTTP response straight into exported variables via command
# substitution — never to stdout and never into the transcript. The one place
# they can reach disk is --cache, which writes the chmod-600 local store on
# purpose. Anything already set in the environment wins, so a local Mac session
# keeps using ~/.config/coffeeflow/secrets.env untouched.
#
# Source it (leading dot). Running it as ./bootstrap-from-db.sh exports into a
# child shell that immediately exits, which does nothing useful.

set +x  # never trace: an expanded line would contain secrets

__cf_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
__cf_quiet=0
__cf_cache=0
for __cf_arg in "$@"; do
  case "$__cf_arg" in
    --quiet) __cf_quiet=1 ;;
    --cache) __cf_cache=1 ;;
  esac
done
unset __cf_arg
__cf_store="${COFFEEFLOW_SECRETS_FILE:-$HOME/.config/coffeeflow/secrets.env}"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "bootstrap-from-db: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set first." >&2
  echo "  Local Mac  : ./scripts/install-secrets.sh --link, then fill the store." >&2
  echo "  Cloud/CI   : configure those two variables in the environment's settings." >&2
else
  # Names to request, from the canonical list.
  __cf_names=$(awk '
    /^#[[:space:]]*vault[[:space:]]*$/      { tier="vault"; next }
    /^#[[:space:]]*bootstrap[[:space:]]*$/  { tier="boot";  next }
    /^[[:space:]]*#/ || /^[[:space:]]*$/    { next }
    tier=="vault"                           { print $1 }
  ' "$__cf_dir/secret-names.txt")

  # Ask only for what is still missing, so a local session makes no network call
  # it does not need.
  __cf_missing=""
  for __cf_n in $__cf_names; do
    if [ -z "$(eval "printf '%s' \"\${$__cf_n:-}\"")" ]; then
      __cf_missing="$__cf_missing $__cf_n"
    fi
  done

  if [ -n "$__cf_missing" ]; then
    # The response body holds secrets, so it goes straight into eval via command
    # substitution — python emits shell-quoted `export` lines and nothing else.
    __cf_exports=$(
      printf '%s' "$__cf_missing" \
      | python3 -c '
import json, sys
names = sys.stdin.read().split()
print(json.dumps({"p_names": names}))
' \
      | curl -s --max-time 30 \
          -X POST "$SUPABASE_URL/rest/v1/rpc/ops_get_secrets" \
          -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
          -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
          -H "Content-Type: application/json" \
          --data-binary @- \
      | python3 -c '
import json, shlex, sys
raw = sys.stdin.read()
try:
    rows = json.loads(raw)
except Exception:
    sys.stderr.write("bootstrap-from-db: could not parse the response (not JSON).\n")
    sys.exit(0)
if isinstance(rows, dict):
    # PostgREST error shape — surface the message, never the payload.
    sys.stderr.write("bootstrap-from-db: %s\n" % rows.get("message", "request rejected"))
    sys.exit(0)
got = []
for r in rows:
    name, secret = r.get("name"), r.get("secret")
    if name and secret:
        print("export %s=%s" % (name, shlex.quote(secret)))
        got.append(name)
sys.stderr.write("bootstrap-from-db: loaded %d secret(s) from Vault: %s\n"
                 % (len(got), " ".join(sorted(got)) or "none"))
'
    )
    if [ -n "$__cf_exports" ]; then
      eval "$__cf_exports"

      # --cache: persist to the local store so later commands in this session do
      # not re-hit the network. Intended for an ephemeral cloud container, whose
      # disk dies with the session; on the Mac the store is already the source.
      if [ "$__cf_cache" -eq 1 ]; then
        mkdir -p "$(dirname "$__cf_store")"
        printf '%s\n' "$__cf_exports" | CF_STORE="$__cf_store" python3 -c '
import os, sys

store = os.environ["CF_STORE"]
new = {}
order = []
for line in sys.stdin.read().splitlines():
    if not line.startswith("export "):
        continue
    name, _, rest = line[len("export "):].partition("=")
    if name not in new:
        order.append(name)
    new[name] = rest

# Replace any existing line for these names rather than appending duplicates.
kept = []
try:
    with open(store) as fh:
        for line in fh.read().splitlines():
            key = line.split("=", 1)[0].strip()
            if key not in new:
                kept.append(line)
except FileNotFoundError:
    kept = [
        "# Fetched from Supabase Vault by scripts/bootstrap-from-db.sh --cache.",
        "# Safe to delete: it is re-fetched on demand.",
    ]

fd = os.open(store, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as fh:
    fh.write("\n".join(kept).rstrip("\n") + "\n")
    for name in order:
        fh.write("%s=%s\n" % (name, new[name]))
os.chmod(store, 0o600)
'
        echo "bootstrap-from-db: cached to $__cf_store (chmod 600)" >&2
      fi
    fi
    unset __cf_exports
  fi
  unset __cf_names __cf_missing __cf_n

  # ── Non-secret operating context — safe to display ─────────────────────────
  if [ "$__cf_quiet" -eq 0 ]; then
    curl -s --max-time 20 \
      "$SUPABASE_URL/rest/v1/ops_profile?select=key,value,description&order=key" \
      -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(rows, dict) or not rows:
    sys.exit(0)
print("Operating profile (public.ops_profile):")
for r in rows:
    print("  %-22s %s" % (r["key"], json.dumps(r["value"], ensure_ascii=False)))
    if r.get("description"):
        print("  %-22s   %s" % ("", r["description"]))
'
  fi
fi

unset __cf_dir __cf_quiet __cf_cache __cf_store
