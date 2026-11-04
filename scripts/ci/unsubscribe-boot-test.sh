#!/usr/bin/env bash
# Unit-tests the signed unsubscribe token, then boots generate-campaign and
# proves the public unsubscribe link refuses forged tokens. Same sandbox as
# gate-boot-tests.sh (empty env, localhost-only network).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
SANDBOX=(env -i PATH="$PATH" HOME="$HOME" ${DENO_DIR:+DENO_DIR="$DENO_DIR"})
"${SANDBOX[@]}" deno run supabase/functions/_shared/unsubscribe_token_test.ts || exit 1
"${SANDBOX[@]}" deno run --allow-env --allow-read --allow-net=0.0.0.0:8000,localhost:8000 \
  supabase/functions/_shared/unsubscribe_boot_test.ts
