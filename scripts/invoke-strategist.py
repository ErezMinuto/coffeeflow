#!/usr/bin/env python3
"""Invoke the deployed strategist-brain edge function over HTTP (no DB creds).

The function is deployed with --no-verify-jwt, so an anonymous POST works
(same as the pg_cron net.http_post calls). Usage:

    python3 scripts/invoke-strategist.py kickoff
    python3 scripts/invoke-strategist.py advance
"""
import json
import sys
import urllib.request
import urllib.error

REF = "ytydgldyeygpzmlxvpvb"
BASE = f"https://{REF}.supabase.co/functions/v1/strategist-brain"


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "advance"
    url = f"{BASE}?mode={mode}&trigger=manual"
    req = urllib.request.Request(
        url, data=b"{}", method="POST",
        headers={"Content-Type": "application/json",
                 "User-Agent": "Mozilla/5.0 strategist-invoke"},
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as resp:
            print(f"HTTP {resp.status}")
            print(json.dumps(json.loads(resp.read().decode()), indent=2))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}")
        print(e.read().decode()[:2000])
        sys.exit(1)


if __name__ == "__main__":
    main()
