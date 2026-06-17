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

if [ "${OPG_RUN_MIGRATIONS:-true}" = "false" ] || [ "${OPG_RUN_MIGRATIONS:-true}" = "0" ]; then
  echo "Skipping database migrations because OPG_RUN_MIGRATIONS=${OPG_RUN_MIGRATIONS}."
else
  echo "Applying pending database migrations..."
  if "$PRISMA_CLI" migrate deploy --schema "$SCHEMA_PATH"; then
    echo "Prisma migrations applied."
  elif [ "${OPG_REQUIRE_PRISMA_MIGRATIONS:-false}" = "true" ] || [ "${OPG_REQUIRE_PRISMA_MIGRATIONS:-false}" = "1" ]; then
    echo "Prisma migration failed and OPG_REQUIRE_PRISMA_MIGRATIONS=${OPG_REQUIRE_PRISMA_MIGRATIONS}." >&2
    exit 1
  else
    echo "Prisma migration failed; continuing so application startup migrations and readiness checks can report schema state." >&2
  fi
fi

echo "Starting opg-gateway..."
exec node dist/main
