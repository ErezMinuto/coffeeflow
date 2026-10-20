#!/usr/bin/env python3
"""Every table or view a migration creates in `public` must be granted explicitly.

From 2026-10-30 Supabase no longer grants Data API roles on new public tables:
a table created without a GRANT is unreachable even by the service role, so the
edge function that owns it gets "permission denied". This check requires, in the
same file that creates it, a GRANT to service_role on every new public table,
view or materialized view. Grant authenticated only if the app reads it with a
Clerk token, and anon only if it is deliberately public (see CLAUDE.md).

A grant made in a way this check cannot read (format() in a DO block) is
declared with a comment in the file:   -- grants-checked: <name> <why>

Usage: migration_grants_check.py [file ...]
  With no files, checks every migration dated on or after CUTOFF. Older ones
  were applied while the old default grants still existed and are left alone.
"""
import pathlib
import re
import sys

CUTOFF = "20261020"
MIGRATIONS = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "migrations"

IDENT = r'(?:"[^"]+"|[a-z_][a-z0-9_$]*)'
NAME = rf"(?:{IDENT}\.)?{IDENT}"
CREATE_RE = re.compile(
    rf"\bcreate\s+(?:(?:global\s+|local\s+)?(?:temp|temporary)\s+|unlogged\s+)?"
    rf"(table|materialized\s+view|view)\s+(?:if\s+not\s+exists\s+)?({NAME})",
    re.I,
)
# CREATE OR REPLACE VIEW keeps the existing view's grants; only a new view needs them.
OR_REPLACE_VIEW_RE = re.compile(r"\bcreate\s+or\s+replace\s+(?:temp\w*\s+)?view\b", re.I)
GRANT_RE = re.compile(r"\bgrant\s+(.+?)\s+on\s+(.+?)\s+to\s+(.+)", re.I | re.S)
ALL_IN_PUBLIC_RE = re.compile(r"^all\s+tables\s+in\s+schema\s+(?:public|\"public\")$", re.I)
WAIVER_RE = re.compile(rf"--\s*grants-checked:\s*({NAME})", re.I)


def norm(name: str) -> tuple[str | None, str]:
    parts = [p.strip('"') if p.startswith('"') else p.lower() for p in re.findall(IDENT, name, re.I)]
    return (parts[0], parts[1]) if len(parts) == 2 else (None, parts[0])


def strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


def check(path: pathlib.Path) -> list[str]:
    raw = path.read_text()
    waived = {norm(m)[1] for m in WAIVER_RE.findall(raw)}
    sql = strip_comments(raw)

    created: dict[str, str] = {}
    for m in CREATE_RE.finditer(sql):
        kind = re.sub(r"\s+", " ", m.group(1).lower())
        if kind == "view" and OR_REPLACE_VIEW_RE.search(sql, max(0, m.start() - 40), m.end()):
            continue
        if re.search(r"\b(?:temp|temporary)\b", m.group(0), re.I):
            continue
        schema, name = norm(m.group(2))
        if schema in (None, "public"):
            created.setdefault(name, kind)

    granted: set[str] = set()
    all_tables = False
    for stmt in sql.split(";"):
        g = GRANT_RE.search(stmt)
        if not g or not re.search(r"\bservice_role\b", g.group(3), re.I):
            continue
        target = re.sub(r"^table\s+", "", g.group(2).strip(), flags=re.I)
        if ALL_IN_PUBLIC_RE.match(target):
            all_tables = True
            continue
        for obj in target.split(","):
            schema, name = norm(obj.strip())
            if schema in (None, "public"):
                granted.add(name)

    if all_tables:
        return []
    return [
        f"{path.name}: {kind} public.{name} is created without a GRANT to service_role"
        for name, kind in created.items()
        if name not in granted and name not in waived
    ]


def main(argv: list[str]) -> int:
    files = [pathlib.Path(a) for a in argv] or sorted(
        p for p in MIGRATIONS.glob("*.sql") if p.name >= CUTOFF
    )
    errors = [e for f in files for e in check(f)]
    for e in errors:
        print(f"::error::{e}")
    if errors:
        print(
            "\nSince 2026-10-30 Supabase does not grant new public tables to the API roles.\n"
            "Add to the same migration, after the CREATE (see CLAUDE.md, 'New tables need explicit grants'):\n"
            "  grant select, insert, update, delete on public.<table> to service_role;\n"
            "  -- only if the app reads it with a Clerk token:\n"
            "  grant select, insert, update, delete on public.<table> to authenticated;"
        )
        return 1
    print(f"migration grants: {len(files)} file(s) checked, all new public tables granted")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
