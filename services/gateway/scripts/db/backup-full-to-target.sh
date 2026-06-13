#!/usr/bin/env bash
set -Eeuo pipefail

# Full backup + restore pipeline:
#   source DB (DATABASE_URL/SOURCE_DATABASE_URL) -> target backup DB (BACKUP_DATABASE_URL/BACKUP_DB_URL)
#
# Required env:
#   - DATABASE_URL (or SOURCE_DATABASE_URL)
#   - BACKUP_DATABASE_URL (or BACKUP_DB_URL)
#
# Optional env:
#   - BACKUP_PARALLEL_JOBS (default: 4)  # used by pg_restore --jobs
#   - BACKUP_DUMP_PATH                    # default: /tmp/gateway_full_backup_<timestamp>.dump
#   - BACKUP_KEEP_DUMP=1                  # keep dump file after script exits

SOURCE_DB_URL="${SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
TARGET_DB_URL="${BACKUP_DATABASE_URL:-${BACKUP_DB_URL:-}}"
PARALLEL_JOBS="${BACKUP_PARALLEL_JOBS:-4}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DEFAULT_DUMP_PATH="/tmp/gateway_full_backup_${TIMESTAMP}.dump"
DUMP_PATH="${BACKUP_DUMP_PATH:-$DEFAULT_DUMP_PATH}"
KEEP_DUMP="${BACKUP_KEEP_DUMP:-0}"
RESTORE_LOG="/tmp/gateway_restore_${TIMESTAMP}.log"

log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $*"
}

log_warn() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $*"
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*"
}

if [[ -z "$SOURCE_DB_URL" ]]; then
  log_error "Missing source DB URL. Set DATABASE_URL or SOURCE_DATABASE_URL."
  exit 1
fi

if [[ -z "$TARGET_DB_URL" ]]; then
  log_error "Missing target backup DB URL. Set BACKUP_DATABASE_URL or BACKUP_DB_URL."
  exit 1
fi

if [[ "$SOURCE_DB_URL" == "$TARGET_DB_URL" ]]; then
  log_error "Source DB URL and target backup DB URL are identical. Abort."
  exit 1
fi

if ! [[ "$PARALLEL_JOBS" =~ ^[0-9]+$ ]] || [[ "$PARALLEL_JOBS" -lt 1 ]]; then
  log_error "BACKUP_PARALLEL_JOBS must be a positive integer. Got: $PARALLEL_JOBS"
  exit 1
fi

for cmd in pg_dump pg_restore psql; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "Required command not found: $cmd"
    exit 1
  fi
done

cleanup() {
  if [[ "$KEEP_DUMP" == "1" ]]; then
    log_info "BACKUP_KEEP_DUMP=1, keep dump file: $DUMP_PATH"
    return
  fi
  if [[ -f "$DUMP_PATH" ]]; then
    log_info "Cleaning temporary dump file: $DUMP_PATH"
    rm -f "$DUMP_PATH"
  fi
}
trap cleanup EXIT

log_info "Source DB connectivity check..."
psql "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database() AS source_db, now() AS source_time;" >/dev/null

log_info "Target backup DB connectivity check..."
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database() AS target_db, now() AS target_time;" >/dev/null

SOURCE_SERVER_VERSION="$(psql "$SOURCE_DB_URL" -At -c "SHOW server_version;" | tr -d '\r')"
TARGET_SERVER_VERSION="$(psql "$TARGET_DB_URL" -At -c "SHOW server_version;" | tr -d '\r')"
PG_DUMP_VERSION="$(pg_dump --version | awk '{print $3}')"
PG_RESTORE_VERSION="$(pg_restore --version | awk '{print $3}')"

log_info "Source server version: $SOURCE_SERVER_VERSION"
log_info "Target server version: $TARGET_SERVER_VERSION"
log_info "pg_dump version: $PG_DUMP_VERSION"
log_info "pg_restore version: $PG_RESTORE_VERSION"
log_info "Dumping source DB to $DUMP_PATH ..."
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --dbname="$SOURCE_DB_URL" \
  --file="$DUMP_PATH"

DUMP_SIZE="$(du -h "$DUMP_PATH" | awk '{print $1}')"
log_info "Dump file size: $DUMP_SIZE"
log_info "Restore log path: $RESTORE_LOG"
log_info "Restoring dump into target backup DB (clean + recreate objects)..."

if pg_restore \
  --verbose \
  --exit-on-error \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --jobs="$PARALLEL_JOBS" \
  --dbname="$TARGET_DB_URL" \
  "$DUMP_PATH" 2>&1 | tee "$RESTORE_LOG"; then
  log_info "Restore completed in parallel mode."
else
  if grep -q 'unrecognized configuration parameter "transaction_timeout"' "$RESTORE_LOG"; then
    log_warn "Detected cross-version restore incompatibility: transaction_timeout."
    log_warn "Retry with compatibility mode (sequential restore + filter incompatible SET statements)."

    pg_restore \
      --verbose \
      --exit-on-error \
      --clean \
      --if-exists \
      --no-owner \
      --no-privileges \
      --file=- \
      "$DUMP_PATH" \
      2> >(tee -a "$RESTORE_LOG" >&2) \
      | awk '
          $0 ~ /^SET transaction_timeout = / { next }
          $0 ~ /^SET idle_session_timeout = / { next }
          $0 ~ /^SELECT pg_catalog.set_config\('\''transaction_timeout'\''/ { next }
          $0 ~ /^SELECT pg_catalog.set_config\('\''idle_session_timeout'\''/ { next }
          { print }
        ' \
      | psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1

    log_info "Compatibility mode restore completed."
  else
    log_error "Restore failed. Check log: $RESTORE_LOG"
    exit 1
  fi
fi

log_info "Full backup completed."
log_info "Source data has been fully copied into target backup DB."
