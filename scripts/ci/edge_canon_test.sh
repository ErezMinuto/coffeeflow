#!/usr/bin/env bash
# Regression test for edge_prod_guard.sh's canon(): the same code must
# canonicalise identically whether it comes from git (TypeScript) or from
# production (Deno's type-erased emit), and real changes must still show.
#
#   scripts/ci/edge_canon_test.sh        (needs esbuild on PATH, 0.25.10 in CI)
#
# Fixtures are frozen copies, so editing the real python_literal.ts never
# breaks this test:
#   fixtures/python_literal.git.ts   supabase/functions/_shared/python_literal.ts
#                                    as committed on 2026-10-18
#   fixtures/python_literal.prod.js  the same file through Deno's emitter
#                                    (jsr:@deno/emit transpile), byte-for-byte
#                                    the form production served then
# On 2026-10-18 the guard refused a byte-identical artisan-import because
# class fields printed differently: git `constructor(s){this.s=s}i=0`, prod
# `s;i;constructor(s){this.s=s,this.i=0}`.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$DIR/edge_prod_guard.sh"
FX="$DIR/fixtures"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
fail=0

canon() { bash "$GUARD" --canon "$1"; }

same() {  # name, file a, file b
  if cmp -s <(canon "$2") <(canon "$3"); then echo "ok   $1"
  else echo "FAIL $1: canonical forms differ"; cmp <(canon "$2") <(canon "$3"); fail=1; fi
}
differs() {  # name, sed expression: the prod fixture mutated must not match git
  local m="$WORK/$1.js"
  sed -E "$2" "$FX/python_literal.prod.js" > "$m"
  if cmp -s "$m" "$FX/python_literal.prod.js"; then echo "FAIL $1: sed did not change the fixture"; fail=1; return; fi
  if cmp -s <(canon "$FX/python_literal.git.ts") <(canon "$m"); then echo "FAIL $1: change was hidden"; fail=1
  else echo "ok   $1"; fi
}

command -v esbuild >/dev/null || { echo "esbuild not on PATH"; exit 2; }

# The false positive: git and prod forms of the same code must match.
same    "git ts == prod js (class fields)" "$FX/python_literal.git.ts" "$FX/python_literal.prod.js"

# Fail closed: prod-only code around class fields must still be caught.
differs changed-field-initialiser   's/this\.i = 0;/this.i = 1;/'
differs extra-constructor-statement 's/this\.i = 0;/this.i = 0; this.debug = true;/'
differs extra-field-with-a-value    's/^  i;$/  i;\n  retries = 3;/'
differs extra-method                's/^  parse\(\) \{$/  dump() { return this.s; }\n  parse() {/'
differs changed-error-message       's/at character/at char/'

exit $fail
