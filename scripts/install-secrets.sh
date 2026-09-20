#!/usr/bin/env bash
# One-time setup of the local CoffeeFlow secret store. Run it yourself:
#
#   ./scripts/install-secrets.sh            # create the store, print the loader
#   ./scripts/install-secrets.sh --link     # also append the loader to ~/.zshenv
#
# What it does:
#   1. creates ~/.config/coffeeflow/secrets.env (chmod 600) from the template,
#      never overwriting an existing one
#   2. with --link, adds a guarded block to ~/.zshenv so that file is exported
#      into every shell started inside the CoffeeFlow repo — including the
#      shells Claude Code runs commands in
#
# Result: credentials stop being pasted into chat. Claude reads them by name
# ("$SUPABASE_SERVICE_ROLE_KEY"); the values never enter the transcript.
#
# Safe to re-run. Backs up ~/.zshenv before touching it.

set -euo pipefail

STORE_DIR="$HOME/.config/coffeeflow"
STORE="$STORE_DIR/secrets.env"
ZSHENV="$HOME/.zshenv"
BEGIN="# >>> coffeeflow secrets >>>"
END="# <<< coffeeflow secrets <<<"

# Everything is resolved from where this script lives, not from the current
# directory, so it works when called by an absolute path from anywhere —
# including from a checkout that does not have these scripts on its branch.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/secrets.env.example"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "❌ Cannot find $TEMPLATE — run this script from its own checkout." >&2
  exit 1
fi

# The main checkout, even when this script lives in a git worktree. The ~/.zshenv
# guard is scoped to this path, and worktrees sit under it.
if ! GIT_COMMON=$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  echo "❌ $SCRIPT_DIR is not inside a git repository." >&2
  exit 1
fi
REPO_ROOT=$(dirname "$GIT_COMMON")

# ── 1. the store ──────────────────────────────────────────────────────────────
mkdir -p "$STORE_DIR"
chmod 700 "$STORE_DIR"

if [[ -f "$STORE" ]]; then
  echo "✓ $STORE already exists — left untouched"
else
  cp "$TEMPLATE" "$STORE"
  chmod 600 "$STORE"
  echo "✓ created $STORE (chmod 600) — fill in the blank values"
fi

# ── 2. the loader ─────────────────────────────────────────────────────────────
read -r -d '' LOADER <<LOADER_EOF || true

$BEGIN
# Export ~/.config/coffeeflow/secrets.env into any shell started inside the
# CoffeeFlow repo (git worktrees under it are covered too). Installed by
# scripts/install-secrets.sh. To load it in EVERY shell instead, drop the
# case/esac guard and keep only the three lines inside it.
__cf_root="$REPO_ROOT"
__cf_file="\$HOME/.config/coffeeflow/secrets.env"
case "\$PWD" in
  "\$__cf_root"|"\$__cf_root"/*)
    if [ -r "\$__cf_file" ]; then
      set -a; . "\$__cf_file"; set +a
    fi
    ;;
esac
unset __cf_root __cf_file
$END
LOADER_EOF

if grep -qF "$BEGIN" "$ZSHENV" 2>/dev/null; then
  echo "✓ loader already present in $ZSHENV"
elif [[ "${1:-}" == "--link" ]]; then
  [[ -f "$ZSHENV" ]] && cp "$ZSHENV" "$ZSHENV.bak.$(date +%Y%m%d%H%M%S)"
  printf '%s\n' "$LOADER" >> "$ZSHENV"
  echo "✓ added loader to $ZSHENV (scoped to $REPO_ROOT)"
else
  echo
  echo "Loader NOT installed. Re-run with --link, or paste this into ~/.zshenv:"
  echo "──────────────────────────────────────────────────────────────────────"
  printf '%s\n' "$LOADER"
  echo "──────────────────────────────────────────────────────────────────────"
fi

cat <<'NEXT'

Next:
  1. Open ~/.config/coffeeflow/secrets.env and fill in the values.
     (Quote any value containing a space or a # character.)
  2. Open a NEW terminal — or start a new Claude Code session — so the shell
     picks the file up.
  3. Verify with:  ./scripts/secrets-doctor.sh --live

From then on: never paste a credential into chat. Put it in that file and tell
Claude the variable name.
NEXT
