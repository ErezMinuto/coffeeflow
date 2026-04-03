#!/usr/bin/env bash
# CoffeeFlow — Dev DB Setup Script
#
# Applies all migrations and seeds test data to the dev Supabase project.
# Run this ONCE after creating the dev Supabase project.
#
# Usage:
#   export DEV_DB_URL="postgresql://postgres:<password>@db.<dev-project-id>.supabase.co:5432/postgres"
#   ./scripts/setup-dev-db.sh
#
# You can find the DB connection string in:
#   Supabase Dashboard → Project Settings → Database → Connection string (URI)

set -euo pipefail

if [ -z "${DEV_DB_URL:-}" ]; then
  echo "❌  DEV_DB_URL is not set."
  echo "    Export it first:"
  echo "    export DEV_DB_URL=\"postgresql://postgres:<password>@db.<project-id>.supabase.co:5432/postgres\""
  exit 1
fi

MIGRATIONS_DIR="$(dirname "$0")/../supabase/migrations"
SEED_FILE="$(dirname "$0")/../supabase/seed.sql"

echo "🚀  Applying migrations to dev DB..."

for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "  → $(basename "$f")"
  psql "$DEV_DB_URL" -f "$f" --quiet
done

echo ""
echo "🌱  Seeding dev data..."
psql "$DEV_DB_URL" -f "$SEED_FILE" --quiet

echo ""
echo "✅  Dev DB is ready!"
echo ""
echo "Next steps:"
echo "  1. Copy .env.local.example → .env.local"
echo "  2. Fill in the dev Supabase URL + anon key from the Supabase dashboard"
echo "  3. Run: npm start"
