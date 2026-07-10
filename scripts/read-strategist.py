#!/usr/bin/env python3
"""Read the strategist-brain tables via the PostgREST REST API (anon key).

Usage: python3 scripts/read-strategist.py <anon_key>

Anon key is public (shipped in the dashboard bundle); these tables have anon
SELECT policies. Read-only — prints the latest run, brief, signals, theses, and
this run's cost rollup.
"""
import json
import re
import sys
import urllib.request
import urllib.error

REF = "ytydgldyeygpzmlxvpvb"
BASE = f"https://{REF}.supabase.co/rest/v1"


def resolve_key() -> str:
    # Prefer argv; else extract the first JWT from piped stdin (e.g. the CLI's
    # api-keys output, pre-filtered to the anon row).
    if len(sys.argv) > 1 and sys.argv[1].startswith("eyJ"):
        return sys.argv[1].strip()
    blob = sys.stdin.read()
    m = re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", blob)
    if not m:
        sys.exit("no JWT found on stdin or argv")
    return m.group(0)


def get(path: str, key: str):
    req = urllib.request.Request(
        f"{BASE}/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "User-Agent": "Mozilla/5.0 strategist-read"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()[:300]}


def main() -> None:
    key = resolve_key()
    # Mimic claimRun's exact filter to see if it returns the candidate.
    now = "2030-01-01T00:00:00.000Z"  # far future so lt always true if column set
    test = get(f"strategist_runs?status=eq.thinking&or=(locked_until.is.null,locked_until.lt.{now})&select=id,status,locked_until", key)
    print("=== CLAIM-FILTER TEST ===")
    print(json.dumps(test, indent=2, ensure_ascii=False))
    print()
    runs = get("strategist_runs?select=id,status,steps_taken,max_steps,week_start,error,cost_tokens,brief_id,locked_until,worker_id,updated_at&order=created_at.desc&limit=3", key)
    print("=== RUNS ===")
    print(json.dumps(runs, indent=2, ensure_ascii=False))

    briefs = get("strategic_briefs?select=id,week_start,summary,top_thesis,status,created_at&order=created_at.desc&limit=2", key)
    print("\n=== BRIEFS ===")
    print(json.dumps(briefs, indent=2, ensure_ascii=False))

    theses = get("strategic_theses?select=id,thesis,lever,success_metric,check_date,status&order=created_at.desc&limit=10", key)
    print("\n=== THESES ===")
    print(json.dumps(theses, indent=2, ensure_ascii=False))

    signals = get("strategist_signals?select=id,kind,title,status,dedupe_key&order=created_at.desc&limit=10", key)
    print("\n=== SIGNALS ===")
    print(json.dumps(signals, indent=2, ensure_ascii=False))

    cost = get("agent_cost_ledger?select=source_fn,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,est_usd&order=created_at.desc&limit=20", key)
    print("\n=== COST LEDGER (recent) ===")
    print(json.dumps(cost, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
