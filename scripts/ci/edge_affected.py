#!/usr/bin/env python3
"""Which edge functions does a git range change?

    python3 scripts/ci/edge_affected.py <base-sha> <head-sha>

Prints one function name per line: every function whose OWN bundle contains a
file changed between base and head. "Own bundle" means index.ts plus every
local module it reaches through relative imports, followed transitively, so a
change to _shared/visual_identity.ts selects exactly the functions that import
it (directly or through seo-agent/*), not all 59 and not just the ones whose
folder changed.

Remote imports (https://, npm:, jsr:) are ignored: they are not in the repo,
and a version bump to one shows up as a change to the importing file anyway.

Deliberately offline and dependency-free (no `deno info`): it must run in a
couple of seconds on a bare runner and give the same answer every time.
"""
import os
import re
import subprocess
import sys

ROOT = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
FUNCS = os.path.join(ROOT, "supabase", "functions")
NOT_FUNCTIONS = {"_shared", "seo-agent"}

# import x from "./a.ts" · export { y } from '../b.ts' · import "./c.ts" · import("./d.ts")
IMPORT_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]""",
)


def local_imports(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            src = fh.read()
    except OSError:
        return []
    base = os.path.dirname(path)
    return [os.path.normpath(os.path.join(base, spec)) for spec in IMPORT_RE.findall(src)]


def bundle(entry):
    seen, stack = set(), [entry]
    while stack:
        p = stack.pop()
        if p in seen or not os.path.isfile(p):
            continue
        seen.add(p)
        stack.extend(local_imports(p))
    return seen


def changed_files(base, head):
    out = subprocess.check_output(
        ["git", "diff", "--name-only", f"{base}..{head}", "--", "supabase/functions"],
        cwd=ROOT, text=True,
    )
    return {os.path.normpath(os.path.join(ROOT, line)) for line in out.splitlines() if line}


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: edge_affected.py <base-sha> <head-sha>")
    changed = changed_files(sys.argv[1], sys.argv[2])
    if not changed:
        return
    for name in sorted(os.listdir(FUNCS)):
        if name in NOT_FUNCTIONS:
            continue
        fdir = os.path.join(FUNCS, name)
        entry = os.path.join(fdir, "index.ts")
        if not os.path.isfile(entry):
            continue
        files = bundle(entry)
        # Non-code files inside the function's own folder (deno.json, assets) count too.
        own = {c for c in changed if c.startswith(fdir + os.sep)}
        if files & changed or own:
            print(name)


if __name__ == "__main__":
    main()
