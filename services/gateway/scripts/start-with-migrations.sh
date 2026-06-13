#!/usr/bin/env sh
set -eu

SCHEMA_PATH="${PRISMA_SCHEMA_PATH:-./prisma/schema.prisma}"
PRISMA_CLI="./node_modules/.bin/prisma"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required before starting opg-gateway." >&2
  exit 1
fi

if [ ! -x "$PRISMA_CLI" ]; then
  echo "Prisma CLI is missing from the runtime image." >&2
  exit 1
fi

echo "Checking database migration status..."
"$PRISMA_CLI" migrate status --schema "$SCHEMA_PATH" || true

echo "Applying pending database migrations..."
"$PRISMA_CLI" migrate deploy --schema "$SCHEMA_PATH"

echo "Starting opg-gateway..."
exec node dist/main
