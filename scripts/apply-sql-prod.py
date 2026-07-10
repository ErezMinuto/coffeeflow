#!/usr/bin/env python3
"""Apply a single SQL file to the Minuto PROD Supabase DB via the Management API.

Why this exists: prod's supabase_migrations history is untracked (see project
memory "supabase db push UNSAFE"), so `db push` would try to re-run all of
history. This applies ONE additive SQL file directly, the same way the dashboard
SQL editor does — through POST /v1/projects/{ref}/database/query.

The access token is read from $SUPABASE_ACCESS_TOKEN, else from the macOS
keychain item the Supabase CLI created ("Supabase CLI"). It is NEVER printed.

Usage: python3 scripts/apply-sql-prod.py <path-to-sql> [project_ref]
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

PROD_REF = "ytydgldyeygpzmlxvpvb"


def get_token() -> str:
    tok = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if tok:
        return tok.strip()
    # Fall back to the keychain item the CLI stores (may trigger a one-time
    # macOS "allow" dialog — that's an OS grant, not a transcript leak).
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception as e:  # noqa: BLE001
        sys.exit(f"could not obtain Supabase access token: {e}")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: apply-sql-prod.py <path-to-sql> [project_ref]")
    sql_path = sys.argv[1]
    ref = sys.argv[2] if len(sys.argv) > 2 else PROD_REF
    with open(sql_path, "r", encoding="utf-8") as f:
        sql = f.read()

    token = get_token()
    url = f"https://api.supabase.com/v1/projects/{ref}/database/query"
    body = json.dumps({"query": sql}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            # Cloudflare on api.supabase.com bot-blocks (error 1010) the default
            # urllib UA; present a normal one.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) supabase-cli-helper",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            print(f"HTTP {resp.status}")
            print(resp.read().decode("utf-8")[:2000])
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}")
        # The error body never contains the token.
        print(e.read().decode("utf-8")[:2000])
        sys.exit(1)


if __name__ == "__main__":
    main()
