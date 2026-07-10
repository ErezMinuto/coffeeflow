#!/usr/bin/env python3
"""Drive the strategist-brain to completion by calling advance in a loop.

Each advance does ~one deep Opus step (the cron would do this every 2 min; this
just drives it faster for a test run). Stops when the run concludes (brief_ready),
fails, or there's no active run. Prints each tick's result.

Usage: python3 scripts/drive-strategist.py [max_ticks]
"""
import json
import sys
import time
import urllib.request
import urllib.error

REF = "ytydgldyeygpzmlxvpvb"
URL = f"https://{REF}.supabase.co/functions/v1/strategist-brain?mode=advance&trigger=manual"


def tick():
    req = urllib.request.Request(
        URL, data=b"{}", method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 drive"},
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "_body": e.read().decode()[:300]}
    except Exception as e:  # noqa: BLE001
        return {"_err": str(e)}


def main() -> None:
    max_ticks = int(sys.argv[1]) if len(sys.argv) > 1 else 15
    for i in range(1, max_ticks + 1):
        r = tick()
        print(f"[tick {i}] {json.dumps(r)}", flush=True)
        status = r.get("status")
        if r.get("concluded") or status in ("brief_ready", "failed"):
            print(f"DONE: {status}", flush=True)
            return
        if r.get("idle"):
            print("IDLE: no active run (already concluded, or locked by cron)", flush=True)
            return
        time.sleep(3)
    print("max_ticks reached without terminal state", flush=True)


if __name__ == "__main__":
    main()
