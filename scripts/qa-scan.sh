#!/usr/bin/env bash
# CoffeeFlow — one-command QA scan. Is my checkout sane, do the guards hold,
# and is anything in production quietly failing?
#
#   ./scripts/qa-scan.sh              everything except the DB dry-runs
#   ./scripts/qa-scan.sh --quick      skip the slow edge boot tests
#   ./scripts/qa-scan.sh --db         also run the scripts/ci/*_check.sql dry-runs
#   ./scripts/qa-scan.sh --since 72h  widen the production window (default 24h)
#
# Sections
#   1. git      clean tree? in sync with origin/main?
#   2. guards   scripts/ci/*.sh — edge gate boot tests, token-log tests, the
#               deploy guard's canonical-form test, the PR QA checker's self-test
#   3. db       (--db) scripts/ci/*_check.sql — access + atomic-counter checks.
#               Each ends in RAISE EXCEPTION, so every write rolls back; they
#               need SUPABASE_ACCESS_TOKEN and run against PROD (read-safe).
#   4. tasks    seo_tasks that retried (attempts >= 2) or gave up to a human
#               (result_data.review_required) — top failure reasons
#   5. logs     ./scripts/logs.sh errors: unhandled exceptions vs. handled
#               refusals, plus runs killed mid-flight
#
# Ends with a scorecard of [OK] / [WARN] / [FAIL]. Exit 1 on any FAIL.
#
# Read-only against production (GETs, and with --db rolled-back dry-runs).
# Credentials are used by expansion only and never printed.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

PROJECT_REF="${PROJECT_REF:-ytydgldyeygpzmlxvpvb}"
QUICK=0 ; DB=0 ; SINCE="24h"
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ; shift ;;
    --db)    DB=1 ; shift ;;
    --since) SINCE="${2:-24h}" ; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ;;
    *) echo "unknown option: $1" >&2 ; exit 2 ;;
  esac
done

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; RD=$'\033[31m'; B=$'\033[1m'; D=$'\033[90m'; R=$'\033[0m'
else G=""; Y=""; RD=""; B=""; D=""; R=""; fi

SCORE=()   # "LEVEL|name|detail"
score() { SCORE+=("$1|$2|$3"); }
section() { printf "\n${B}── %s %s${R}\n" "$1" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── 1. git ────────────────────────────────────────────────────────────────
section "1. git"
branch="$(git branch --show-current)"
if git fetch -q origin main 2>/dev/null; then
  behind="$(git rev-list --count HEAD..origin/main)"; ahead="$(git rev-list --count origin/main..HEAD)"
  echo "branch ${branch:-detached} — ${ahead} ahead, ${behind} behind origin/main"
  if [ "$behind" -eq 0 ]; then score OK "git: sync" "up to date with origin/main"
  elif [ "$behind" -le 20 ]; then score WARN "git: sync" "${behind} commit(s) behind origin/main — pull/rebase before shipping"
  else score FAIL "git: sync" "${behind} commits behind origin/main — you are testing old code (CLAUDE.md: always pull first)"; fi
else
  score WARN "git: sync" "could not fetch origin/main (offline?)"
fi
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
if [ "$dirty" -eq 0 ]; then score OK "git: clean" "working tree clean"
else
  git status --short | head -10 | sed 's/^/  /'; [ "$dirty" -gt 10 ] && echo "  … and $((dirty - 10)) more"
  score WARN "git: clean" "${dirty} uncommitted/untracked path(s)"
fi
[ "$branch" = main ] && score WARN "git: branch" "on main — CLAUDE.md: never push directly to main, branch + PR"

# ── 2. guards (scripts/ci/*.sh) ───────────────────────────────────────────
section "2. guards — scripts/ci/*.sh"
run_guard() { # name needs-tool command...
  local name="$1" need="$2"; shift 2
  if [ -n "$need" ] && ! command -v "$need" >/dev/null 2>&1; then
    echo "${Y}skip${R}  $name ${D}(needs $need)${R}"; score WARN "guard: $name" "skipped — $need not installed"; return
  fi
  printf "run   %s … " "$name"
  if "$@" > "$TMP/guard.out" 2>&1; then
    echo "${G}ok${R}"; score OK "guard: $name" "$(tail -1 "$TMP/guard.out" | cut -c1-70)"
  else
    echo "${RD}FAIL${R}"; grep -vE '^(ok |✅)' "$TMP/guard.out" | tail -12 | sed 's/^/      /'
    score FAIL "guard: $name" "$(grep -E 'FAIL|failing|❌' "$TMP/guard.out" | head -1 | cut -c1-70)"
  fi
}
run_guard "qa_review self-test"      python3 bash scripts/ci/qa_review_test.sh
run_guard "edge_canon_test"          esbuild bash scripts/ci/edge_canon_test.sh
if [ "$QUICK" -eq 1 ]; then
  echo "${D}skip  gate-boot-tests, token-log-boot-tests (--quick)${R}"
  score WARN "guard: edge boot tests" "skipped (--quick)"
else
  run_guard "gate-boot-tests"        deno bash scripts/ci/gate-boot-tests.sh
  run_guard "token-log-boot-tests"   deno bash scripts/ci/token-log-boot-tests.sh
fi
# Not run here, on purpose: edge_prod_guard.sh is per-function at deploy time
# (needs <fn> <base> <head>); metrics_diagnose.sh is a timing tool, not a check.
# Deno unit tests that live beside their functions:
for t in supabase/functions/health-watchdog/*_test.ts supabase/functions/seo-worker-visual/no_bag_tail_test.ts; do
  [ -f "$t" ] || continue
  run_guard "$(basename "$t" .ts)" deno deno run --quiet "$t"
done

# ── 3. db dry-runs (--db) ─────────────────────────────────────────────────
section "3. db — scripts/ci/*_check.sql"
if [ "$DB" -eq 0 ]; then
  echo "${D}skipped — pass --db to run the rolled-back access/counter checks against prod${R}"
elif [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  score WARN "db: checks" "skipped — SUPABASE_ACCESS_TOKEN not set (./scripts/secrets-doctor.sh)"
else
  for f in scripts/ci/*_check.sql; do
    name="$(basename "$f" .sql)"
    curl -sS -m 60 -o "$TMP/db.json" -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json" \
      --data "$(jq -n --rawfile q "$f" '{query:$q}')" 2>/dev/null
    # The checks report through RAISE EXCEPTION 'DRYRUN_RESULT {...}', so the
    # "error" body IS the result. Anything else is a real failure to run.
    res="$(grep -oE 'DRYRUN_RESULT [^"\\]*(\\.[^"\\]*)*' "$TMP/db.json" | head -1 | sed 's/^DRYRUN_RESULT //; s/\\"/"/g')"
    if [ -z "$res" ]; then
      echo "${RD}FAIL${R}  $name — did not produce a DRYRUN_RESULT: $(head -c 160 "$TMP/db.json")"
      score FAIL "db: $name" "no DRYRUN_RESULT (migration not applied? see file header)"
    elif echo "$res" | grep -q '"FAIL"'; then
      echo "${RD}FAIL${R}  $name"; echo "$res" | tr ',' '\n' | grep FAIL | sed 's/^/      /'
      score FAIL "db: $name" "$(echo "$res" | grep -o '"[^"]*": *"FAIL"' | head -3 | tr '\n' ' ')"
    else
      echo "${G}ok${R}    $name ${D}$(echo "$res" | cut -c1-120)${R}"
      score OK "db: $name" "no FAIL in result (compare counts with the file header)"
    fi
  done
fi

# ── service-role key for the read-only REST queries below ─────────────────
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
LOGS_CACHE="${TMPDIR:-/tmp}/.coffeeflow-logs-${PROJECT_REF}"
[ -z "$KEY" ] && [ -r "$LOGS_CACHE" ] && KEY="$(cat "$LOGS_CACHE")"
since_iso() { python3 -c "
import sys, datetime as d, re
m = re.fullmatch(r'(\d+)([mhd])', sys.argv[1]) or sys.exit('bad --since: ' + sys.argv[1])
n, u = int(m[1]), m[2]
dt = d.datetime.now(d.timezone.utc) - d.timedelta(**{{'m':'minutes','h':'hours','d':'days'}[u]: n})
print(dt.strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1"; }
SINCE_ISO="$(since_iso "$SINCE")" || exit 2

# ── 4. seo_tasks retries + review_required ────────────────────────────────
section "4. tasks — retried or handed to a human (since $SINCE)"
if [ -z "$KEY" ]; then
  echo "${Y}skip${R} no SUPABASE_SERVICE_ROLE_KEY"; score WARN "tasks: scan" "skipped — no service-role key"
else
  curl -sS -m 30 -o "$TMP/tasks.json" -G "https://${PROJECT_REF}.supabase.co/rest/v1/seo_tasks" \
    -H "apikey: ${KEY}" -H "Authorization: Bearer ${KEY}" \
    --data-urlencode "select=id,task_type,status,attempts,max_attempts,error_msg,updated_at,review_required:result_data->>review_required,crit:result_data->qa_last_critique,slides:result_data->slide_qa" \
    --data-urlencode "or=(attempts.gte.2,result_data->>review_required.eq.true)" \
    --data-urlencode "updated_at=gte.${SINCE_ISO}" \
    --data-urlencode "order=updated_at.desc" --data-urlencode "limit=300"
  TASKS_JSON="$TMP/tasks.json" python3 > "$TMP/tasks.out" <<'PY'
import json, os, re, collections
try:
    rows = json.load(open(os.environ['TASKS_JSON']))
except Exception as e:
    print("ERR unreadable response"); raise SystemExit
if isinstance(rows, dict):
    print("ERR", rows.get('message', rows)); raise SystemExit
# Same marker rule as health-watchdog: [chat-cancel] etc. are decisions, not faults.
MARK = re.compile(r'^\s*\[[a-z0-9 _-]+\]', re.I)
def norm(msg):
    m = re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27,}', '<id>', msg or '')
    m = re.sub(r'\d+', 'N', m)
    return m.strip()[:110] or '(no error_msg)'
reasons = collections.Counter(); crits = collections.Counter()
retried = review = failed = 0
for r in rows:
    if MARK.match(r.get('error_msg') or ''):
        continue
    if (r.get('attempts') or 0) >= 2: retried += 1
    if r.get('status') == 'failed': failed += 1
    if r.get('error_msg'): reasons[(r['task_type'], norm(r['error_msg']))] += 1
    if r.get('review_required') == 'true':
        review += 1
        cs = [r['crit']] if r.get('crit') else []
        for s in (r.get('slides') or []):
            if s.get('passed') is False and s.get('attempts'):
                cs.append(s['attempts'][-1].get('critique') or {})
        for c in cs:
            for i in (c.get('issues') or [])[:2]:
                crits[(r['task_type'], norm(i)[:90])] += 1
print(f"SUMMARY {len(rows)} {retried} {review} {failed}")
for (tt, m), n in reasons.most_common(6): print(f"REASON {n:>3}× {tt:<20} {m}")
for (tt, m), n in crits.most_common(5):   print(f"CRIT   {n:>3}× {tt:<20} {m}")
PY
  if grep -q '^ERR' "$TMP/tasks.out"; then
    echo "${RD}query failed:${R} $(cut -c1-160 "$TMP/tasks.out")"; score WARN "tasks: scan" "query failed"
  else
    read -r _ total retried review failed < <(grep '^SUMMARY' "$TMP/tasks.out")
    echo "${total} task(s): ${retried} retried, ${review} review_required, ${failed} failed (operator cancels excluded)"
    if grep -q '^REASON' "$TMP/tasks.out"; then echo "${B}top failure reasons${R}"; grep '^REASON' "$TMP/tasks.out" | sed 's/^REASON /  /'; fi
    if grep -q '^CRIT' "$TMP/tasks.out"; then echo "${B}top QA critiques (review_required)${R}"; grep '^CRIT' "$TMP/tasks.out" | sed 's/^CRIT   /  /'; fi
    top="$(grep -m1 '^REASON' "$TMP/tasks.out" | awk '{print $2}' | tr -d '×')"
    if [ "${failed:-0}" -ge 5 ] || [ "${top:-0}" -ge 3 ]; then
      score FAIL "tasks: failures" "${failed} failed; top reason repeats ${top:-0}× — a repeating error is a bug"
    elif [ "${failed:-0}" -gt 0 ] || [ "${review:-0}" -gt 0 ]; then
      score WARN "tasks: failures" "${failed} failed, ${review} awaiting human review"
    else
      score OK "tasks: failures" "no genuine failures or review hand-offs"
    fi
  fi
fi

# ── 5. logs — unhandled exceptions vs handled refusals ────────────────────
section "5. logs — ./scripts/logs.sh errors --since $SINCE"
if ./scripts/logs.sh errors --since "$SINCE" --limit 300 --json > "$TMP/errs.json" 2>"$TMP/errs.err" \
   && ./scripts/logs.sh runs --since "$SINCE" --status incomplete --limit 50 --json > "$TMP/inc.json" 2>>"$TMP/errs.err"; then
  ERRS="$TMP/errs.json" INC="$TMP/inc.json" RD="$RD" Y="$Y" D="$D" R="$R" python3 > "$TMP/logs.out" <<'PY'
import json, os, collections, datetime as dt
E = os.environ
def load(p):
    try:
        v = json.load(open(p)); return v if isinstance(v, list) else []
    except Exception:
        return []
lines, inc = load(E['ERRS']), load(E['INC'])
# A run is killed only once it is clearly not still running.
now = dt.datetime.now(dt.timezone.utc)
inc = [r for r in inc if r.get('started_at') and (now - dt.datetime.fromisoformat(r['started_at'].replace('Z', '+00:00'))).total_seconds() > 900]
exc = [l for l in lines if l.get('level') == 'error' and (l.get('error_stack') or l.get('error_name'))]
handled = [l for l in lines if l.get('level') == 'error' and l.get('event') == 'run.finish'
           and isinstance(l.get('data'), dict) and isinstance(l['data'].get('code'), str)]
bare = [l for l in lines if l.get('level') == 'error' and l not in exc and l not in handled]
warns = [l for l in lines if l.get('level') == 'warn']
print(f"SUMMARY {len(exc)} {len(bare)} {len(handled)} {len(warns)} {len(inc)}")
by = collections.Counter((l.get('fn'), l.get('event'), f"{l.get('error_name') or ''}: {(l.get('message') or '')[:80]}") for l in exc)
for (fn, ev, msg), n in by.most_common(8):
    print(f"EXC {E['RD']}{n:>3}×{E['R']} {fn:<26} {ev or '':<18} {msg}")
for l in bare[:5]:
    print(f"BARE      {l.get('fn'):<26} {l.get('event') or '':<18} {(l.get('message') or '')[:80]}")
codes = collections.Counter((l.get('fn'), l['data']['code']) for l in handled)
for (fn, code), n in codes.most_common(5):
    print(f"HANDLED {E['D']}{n:>3}× {fn:<26} code={code}{E['R']}")
for r in inc[:5]:
    print(f"KILLED    {r.get('fn'):<26} started {r.get('started_at','')[:19]}  run {r.get('run_id')}")
PY
  read -r _ nexc nbare nhandled nwarn ninc < <(grep '^SUMMARY' "$TMP/logs.out")
  echo "${nexc} unhandled exception line(s), ${nbare} error(s) without a code, ${nhandled} handled refusal(s), ${nwarn} warning(s), ${ninc} run(s) killed mid-flight"
  grep -E '^(EXC|BARE|KILLED)' "$TMP/logs.out" | sed -E 's/^(EXC|BARE|KILLED) */  /'
  grep '^HANDLED' "$TMP/logs.out" | sed 's/^HANDLED /  /'
  [ "${nexc:-0}" -gt 0 ] && echo "  ${D}trace one: ./scripts/logs.sh errors --since $SINCE   then   ./scripts/logs.sh run <run-id>${R}"
  if [ "${ninc:-0}" -gt 0 ] || [ "${nbare:-0}" -gt 0 ]; then
    score FAIL "logs: crashes" "${ninc} killed run(s), ${nbare} uncoded error(s)"
  elif [ "${nexc:-0}" -gt 0 ]; then
    score WARN "logs: crashes" "${nexc} exception line(s) — caught (run not killed), check they are expected"
  else
    score OK "logs: crashes" "no unhandled exceptions or killed runs (${nhandled} handled refusals)"
  fi
else
  echo "${Y}could not read logs:${R} $(head -2 "$TMP/errs.err")"; score WARN "logs: scan" "logs.sh failed — see above"
fi

# ── scorecard ─────────────────────────────────────────────────────────────
section "scorecard"
nf=0; nw=0
for row in "${SCORE[@]}"; do
  IFS='|' read -r lvl name detail <<< "$row"
  case "$lvl" in
    OK)   tag="${G}[OK]  ${R}" ;;
    WARN) tag="${Y}[WARN]${R}"; nw=$((nw + 1)) ;;
    FAIL) tag="${RD}[FAIL]${R}"; nf=$((nf + 1)) ;;
  esac
  printf "%s %-28s %s\n" "$tag" "$name" "${D}${detail}${R}"
done
echo
if [ "$nf" -gt 0 ]; then echo "${RD}${B}${nf} FAIL${R}, ${nw} WARN"; exit 1
elif [ "$nw" -gt 0 ]; then echo "${Y}${B}0 FAIL${R}, ${nw} WARN"
else echo "${G}${B}all clear${R}"; fi
