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
  set -- $(deno eval "import { GATES } from './$T'; console.log(Object.keys(GATES).join(' '))")
fi
failed=()
for f in "$@"; do
  out="$(deno run --allow-net --allow-env --allow-read "$T" "$f" 2>&1)"
  if [ $? -eq 0 ]; then echo "ok    $f"; else echo "FAIL  $f"; echo "$out" | grep -E '✗|error|Error' -A1 | head -30; failed+=("$f"); fi
done
echo
[ "${#failed[@]}" -eq 0 ] && echo "all gates hold" || { echo "failing: ${failed[*]}"; exit 1; }
