#!/usr/bin/env bash
# Runs supabase/functions/_shared/token_log_boot_test.ts for each OAuth
# exchange function: they must not log the tokens they receive. Same sandbox
# as gate-boot-tests.sh (empty env, localhost-only network).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
T=supabase/functions/_shared/token_log_boot_test.ts
SANDBOX=(env -i PATH="$PATH" HOME="$HOME" ${DENO_DIR:+DENO_DIR="$DENO_DIR"})
PERMS=(--allow-env --allow-read --allow-net=0.0.0.0:8000,localhost:8000)
failed=()
for f in google-exchange-token meta-exchange-token; do
  out="$("${SANDBOX[@]}" deno run "${PERMS[@]}" "$T" "$f" 2>&1)"
  if [ $? -eq 0 ]; then echo "ok    $f"; else echo "FAIL  $f"; echo "$out" | grep -E '✗|error|Error' -A1 | head -30; failed+=("$f"); fi
done
echo
[ "${#failed[@]}" -eq 0 ] && echo "no tokens logged" || { echo "failing: ${failed[*]}"; exit 1; }
