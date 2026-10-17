#!/usr/bin/env bash
# Runs supabase/functions/_shared/gate_boot_test.ts for every gated function
# (or the ones named), one Deno process each because each boots a server.
#
#   bash scripts/ci/gate-boot-tests.sh
#   bash scripts/ci/gate-boot-tests.sh meta-publish employee-bot
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
T=supabase/functions/_shared/gate_boot_test.ts
if [ "$#" -eq 0 ]; then
  set -- $(env -i PATH="$PATH" HOME="$HOME" deno eval "import { GATES } from './$T'; console.log(Object.keys(GATES).join(' '))")
fi
# Sandbox: the test boots real functions, and a local shell may hold the real
# CoffeeFlow secrets (~/.zshenv loads them). So the run gets an EMPTY
# environment (env -i: only PATH/HOME/DENO_DIR, which Deno needs to find its
# module cache), and the network is limited to the test's own server — even if
# the fetch stub missed a call, nothing could reach a real host with a real key.
# (Remote imports are not governed by --allow-net, so the module cache still fills.)
SANDBOX=(env -i PATH="$PATH" HOME="$HOME" ${DENO_DIR:+DENO_DIR="$DENO_DIR"})
PERMS=(--allow-env --allow-read --allow-net=0.0.0.0:8000,localhost:8000)
failed=()
for f in "$@"; do
  out="$("${SANDBOX[@]}" deno run "${PERMS[@]}" "$T" "$f" 2>&1)"
  if [ $? -eq 0 ]; then echo "ok    $f"; else echo "FAIL  $f"; echo "$out" | grep -E '✗|error|Error' -A1 | head -30; failed+=("$f"); fi
done
echo
[ "${#failed[@]}" -eq 0 ] && echo "all gates hold" || { echo "failing: ${failed[*]}"; exit 1; }
