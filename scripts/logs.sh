#!/usr/bin/env bash
# CoffeeFlow — read the system log.
#
# This is the tool you reach for when something is broken. It reads the
# `system_logs` table (written by supabase/functions/_shared/logger.ts), which
# is durable for 30 days and correlated by run id — unlike console output in
# the Supabase dashboard, which is per-function and gone by the time you look.
#
# ── Quick start ────────────────────────────────────────────────────────
#   ./scripts/logs.sh errors              what is broken (last 24h)
#   ./scripts/logs.sh runs                every invocation + its outcome
#   ./scripts/logs.sh fn meta-sync        one function's lines
#   ./scripts/logs.sh run <run-id>        the full trace of one invocation
#   ./scripts/logs.sh search "429"        find a string in messages/events
#   ./scripts/logs.sh stats               error counts per function
#   ./scripts/logs.sh tail                follow new lines live
#
# ── Typical debugging path ─────────────────────────────────────────────
#   1. ./scripts/logs.sh errors           → spot the failing function
#   2. ./scripts/logs.sh runs --fn <it>   → find the bad run, copy its id
#   3. ./scripts/logs.sh run <id>         → read the whole trace, in order
#
# ── Auth ───────────────────────────────────────────────────────────────
# Needs SUPABASE_ACCESS_TOKEN (the sbp_… management token you already export
# for deploys); the anon key is resolved from it automatically and cached for
# the shell session. Reading is anon-safe — system_logs grants SELECT to anon.
# Set SUPABASE_ANON_KEY yourself to skip the lookup.
#
# Read-only. This script never writes to or deletes from the database.

set -uo pipefail

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
BASE="https://${PROJECT_REF}.supabase.co/rest/v1"

# ── Defaults ───────────────────────────────────────────────────────────
SINCE="" ; LIMIT="" ; LEVEL="" ; FN="" ; JSON=0 ; STATUS=""
CMD="${1:-recent}" ; [ $# -gt 0 ] && shift
case "$CMD" in -h|--help|help) CMD="help" ;; esac

ARG=""
case "$CMD" in
  fn|run|search) ARG="${1:-}" ; [ $# -gt 0 ] && shift ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-}" ; shift 2 ;;
    --limit) LIMIT="${2:-}" ; shift 2 ;;
    --level) LEVEL="${2:-}" ; shift 2 ;;
    --fn)    FN="${2:-}"    ; shift 2 ;;
    --status) STATUS="${2:-}" ; shift 2 ;;
    --json)  JSON=1 ; shift ;;
    -h|--help) CMD="help" ; shift ;;
    *) echo "unknown option: $1" >&2 ; exit 2 ;;
  esac
done

if [ "$CMD" = "help" ]; then sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ; fi

# ── Resolve the anon key ───────────────────────────────────────────────
# Cached in the session temp dir so repeated calls do not hit the management
# API every time. Mode 600 — it is a credential, even if a low-privilege one.
KEY="${SUPABASE_ANON_KEY:-}"
CACHE="${TMPDIR:-/tmp}/.coffeeflow-anon-${PROJECT_REF}"
if [ -z "$KEY" ] && [ -r "$CACHE" ]; then KEY="$(cat "$CACHE" 2>/dev/null)"; fi
if [ -z "$KEY" ]; then
  if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    echo "❌ Need SUPABASE_ANON_KEY, or SUPABASE_ACCESS_TOKEN to look it up." >&2
    echo "   export SUPABASE_ACCESS_TOKEN=sbp_…   (same token deploys use)" >&2
    exit 1
  fi
  # Must be the key literally named 'anon' AND in JWT (eyJ) form. The project
  # also returns sb_publishable_*/sb_secret_* keys, and those do not assign the
  # PostgREST role correctly here — picking one silently yields empty results.
  KEY="$(curl -s "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys" \
        -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      | python3 -c "
import sys, json
try: keys = json.load(sys.stdin)
except Exception: sys.exit()
if not isinstance(keys, list): sys.exit()
for k in keys:
    if k.get('name') == 'anon' and str(k.get('api_key','')).startswith('eyJ'):
        print(k['api_key']); break
")"
  if [ -z "$KEY" ]; then echo "❌ Could not resolve the anon key — is SUPABASE_ACCESS_TOKEN valid?" >&2 ; exit 1 ; fi
  (umask 077 && printf '%s' "$KEY" > "$CACHE") 2>/dev/null
fi

# ── Time window ────────────────────────────────────────────────────────
# Accepts 30m / 6h / 7d. Computed in UTC to match the TIMESTAMPTZ column.
since_iso() {
  python3 - "$1" <<'PY'
import sys, re, datetime
spec = (sys.argv[1] or '').strip().lower()
m = re.fullmatch(r'(\d+)([mhd])', spec)
if not m:
    print(''); raise SystemExit
n, unit = int(m.group(1)), m.group(2)
delta = {'m': datetime.timedelta(minutes=n), 'h': datetime.timedelta(hours=n), 'd': datetime.timedelta(days=n)}[unit]
# 'Z', not '+00:00': an unencoded '+' in a query string decodes to a space,
# which silently corrupts every ts= filter.
print((datetime.datetime.now(datetime.timezone.utc) - delta).isoformat().replace('+00:00', 'Z'))
PY
}

q() { # q <path-with-query>
  curl -s "${BASE}/$1" -H "apikey: ${KEY}" -H "Authorization: Bearer ${KEY}"
}

urlenc() { python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }

# ── Renderers ──────────────────────────────────────────────────────────
render_lines() {
  local payload; payload="$(cat)"
  PAYLOAD="$payload" JSONMODE="$JSON" python3 <<'PY'
import os, sys, json
raw = os.environ.get('PAYLOAD', '')
if not raw.strip():
    print("❌ empty response from PostgREST — network, or the request never left"); raise SystemExit(1)
try: rows = json.loads(raw)
except Exception:
    print("❌ unexpected response:", raw[:400]); raise SystemExit(1)
if isinstance(rows, dict):
    msg = rows.get('message') or rows
    print("❌ query error:", msg)
    if rows.get('code') == '42P01':
        print("   system_logs does not exist — apply supabase/migrations/20260920_system_logs.sql")
    raise SystemExit(1)
if os.environ.get('JSONMODE') == '1':
    print(json.dumps(rows, indent=2, ensure_ascii=False)); raise SystemExit
if not rows:
    print("(no matching log lines)"); raise SystemExit

C = {'error':'\033[31m','warn':'\033[33m','info':'\033[0m','debug':'\033[90m'}
R = '\033[0m'; DIM = '\033[90m'
for r in reversed(rows):                      # oldest first: reads like a story
    lvl = r.get('level','info')
    ts  = (r.get('ts') or '')[:19].replace('T',' ')
    run = (r.get('run_id') or '')[:8]
    ev  = r.get('event') or '-'
    # Terminal rows already say the duration in their message; appending it
    # again just prints the number twice.
    dur = '' if r.get('run_status') else (f" {r['duration_ms']}ms" if r.get('duration_ms') else '')
    print(f"{DIM}{ts}{R} {C.get(lvl,'')}{lvl.upper():<5}{R} {DIM}{run}{R} {r.get('fn','?'):<26} {C.get(lvl,'')}{ev}{R} — {r.get('message','')}{dur}")
    data = r.get('data')
    if data not in (None, {}, []):
        s = json.dumps(data, ensure_ascii=False)
        print(f"      {DIM}{s if len(s) <= 400 else s[:400] + '…'}{R}")
    if r.get('error_stack'):
        for ln in str(r['error_stack']).splitlines()[:6]:
            print(f"      \033[31m{ln}{R}")
PY
}

render_runs() {
  local payload; payload="$(cat)"
  PAYLOAD="$payload" JSONMODE="$JSON" python3 <<'PY'
import os, sys, json
raw = os.environ.get('PAYLOAD', '')
if not raw.strip():
    print("❌ empty response from PostgREST"); raise SystemExit(1)
try: rows = json.loads(raw)
except Exception:
    print("❌ unexpected response:", raw[:400]); raise SystemExit(1)
if isinstance(rows, dict):
    msg = rows.get('message') or rows
    print("❌ query error:", msg)
    if rows.get('code') == '42P01':
        print("   system_log_runs does not exist — apply supabase/migrations/20260920_system_logs.sql")
    raise SystemExit(1)
if os.environ.get('JSONMODE') == '1':
    print(json.dumps(rows, indent=2, ensure_ascii=False)); raise SystemExit
if not rows:
    print("(no runs recorded)"); raise SystemExit

MARK = {'success':'\033[32m✓\033[0m', 'error':'\033[31m✗\033[0m',
        'partial':'\033[33m~\033[0m', 'incomplete':'\033[35m⚠\033[0m'}
DIM='\033[90m'; R='\033[0m'
print(f"{'':1} {'started (UTC)':<19} {'function':<26} {'dur':>8}  {'err':>3} {'warn':>4}  run id")
for r in rows:
    st  = r.get('status','?')
    dur = f"{r['duration_ms']}ms" if r.get('duration_ms') else '—'
    print(f"{MARK.get(st,'?')} {(r.get('started_at') or '')[:19].replace('T',' '):<19} "
          f"{(r.get('fn') or '?'):<26} {dur:>8}  {r.get('errors',0):>3} {r.get('warnings',0):>4}  {DIM}{r.get('run_id','')}{R}")
print(f"\n{DIM}⚠ incomplete = the run never wrote a terminal line; it was killed mid-flight (timeout/OOM).{R}")
PY
}

# ── Commands ───────────────────────────────────────────────────────────
case "$CMD" in
  recent)
    S="$(since_iso "${SINCE:-2h}")"
    F="select=*&order=ts.desc&limit=${LIMIT:-100}&ts=gte.${S}"
    [ -n "$LEVEL" ] && F="${F}&level=eq.${LEVEL}"
    [ -n "$FN" ]    && F="${F}&fn=eq.${FN}"
    q "system_logs?${F}" | render_lines
    ;;

  errors)
    S="$(since_iso "${SINCE:-24h}")"
    F="select=*&order=ts.desc&limit=${LIMIT:-100}&ts=gte.${S}&level=in.(warn,error)"
    [ -n "$FN" ] && F="${F}&fn=eq.${FN}"
    q "system_logs?${F}" | render_lines
    ;;

  fn)
    [ -z "$ARG" ] && { echo "usage: $0 fn <function-name>" >&2; exit 2; }
    S="$(since_iso "${SINCE:-24h}")"
    F="select=*&order=ts.desc&limit=${LIMIT:-150}&ts=gte.${S}&fn=eq.${ARG}"
    [ -n "$LEVEL" ] && F="${F}&level=eq.${LEVEL}"
    q "system_logs?${F}" | render_lines
    ;;

  run)
    # The whole trace, in emitted order. No time filter — you already know
    # which run you want, and bounding it by time would just hide the tail.
    [ -z "$ARG" ] && { echo "usage: $0 run <run-id>" >&2; exit 2; }
    q "system_logs?select=*&run_id=eq.${ARG}&order=seq.desc&limit=1000" | render_lines
    ;;

  runs)
    S="$(since_iso "${SINCE:-24h}")"
    F="select=*&order=started_at.desc&limit=${LIMIT:-40}&started_at=gte.${S}"
    [ -n "$FN" ]     && F="${F}&fn=eq.${FN}"
    [ -n "$STATUS" ] && F="${F}&status=eq.${STATUS}"
    q "system_log_runs?${F}" | render_runs
    ;;

  search)
    [ -z "$ARG" ] && { echo "usage: $0 search <text>" >&2; exit 2; }
    S="$(since_iso "${SINCE:-7d}")"
    PAT="$(urlenc "*${ARG}*")"
    F="select=*&order=ts.desc&limit=${LIMIT:-100}&ts=gte.${S}&or=(message.ilike.${PAT},event.ilike.${PAT},error_stack.ilike.${PAT})"
    [ -n "$FN" ] && F="${F}&fn=eq.${FN}"
    q "system_logs?${F}" | render_lines
    ;;

  stats)
    S="$(since_iso "${SINCE:-24h}")"
    PAYLOAD="$(q "system_logs?select=fn,level&ts=gte.${S}&limit=100000")" SINCE_ISO="$S" python3 <<'PY'
import os, sys, json, collections
raw = os.environ.get('PAYLOAD', '')
try: rows = json.loads(raw)
except Exception:
    print("❌ unexpected response:", raw[:400]); raise SystemExit(1)
if isinstance(rows, dict):
    print("❌ query error:", rows.get('message') or rows); raise SystemExit(1)
if not rows: print("(no log lines in window)"); raise SystemExit

agg = collections.defaultdict(lambda: collections.Counter())
for r in rows: agg[r.get('fn','?')][r.get('level','info')] += 1
print(f"since {os.environ.get('SINCE_ISO','')[:19]} UTC\n")
print(f"{'function':<28} {'lines':>7} {'warn':>6} {'error':>6}")
# Worst first: the function with most errors is the one to look at.
for fn, c in sorted(agg.items(), key=lambda kv: (-kv[1]['error'], -kv[1]['warn'], -sum(kv[1].values()))):
    e, w = c['error'], c['warn']
    mark = '\033[31m' if e else ('\033[33m' if w else '\033[90m')
    print(f"{mark}{fn:<28}\033[0m {sum(c.values()):>7} {w:>6} {e:>6}")
PY
    ;;

  tail)
    # Poll rather than stream: PostgREST has no push, and a 5s poll is plenty
    # for watching a cron fire or reproducing a bug by hand.
    echo "tailing system_logs (ctrl-C to stop)…" >&2
    LAST="$(since_iso "${SINCE:-5m}")"
    while true; do
      F="select=*&order=ts.desc&limit=200&ts=gt.${LAST}"
      [ -n "$FN" ]    && F="${F}&fn=eq.${FN}"
      [ -n "$LEVEL" ] && F="${F}&level=eq.${LEVEL}"
      OUT="$(q "system_logs?${F}")"
      NEW="$(PAYLOAD="$OUT" python3 -c "
import os, json
try: rows = json.loads(os.environ.get('PAYLOAD','') or '[]')
except Exception: raise SystemExit
if isinstance(rows, list) and rows: print(max(r['ts'] for r in rows))
")"
      printf '%s' "$OUT" | render_lines | grep -v '^(no matching log lines)$'
      [ -n "$NEW" ] && LAST="$NEW"
      sleep 5
    done
    ;;

  *) echo "unknown command: $CMD (try --help)" >&2 ; exit 2 ;;
esac
