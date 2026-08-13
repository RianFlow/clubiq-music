#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
backup_root="${BACKUP_DIR:-$project_dir/backups}"
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
target="$backup_root/$stamp"

mkdir -p "$target"
cd "$project_dir"

docker compose exec -T db sh -ec \
  'pg_dump --clean --if-exists --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  | gzip -9 > "$target/database.sql.gz"

gzip -t "$target/database.sql.gz"
zgrep -q 'CREATE TABLE' "$target/database.sql.gz"
sha256sum "$target/database.sql.gz" > "$target/SHA256SUMS"
sha256sum -c "$target/SHA256SUMS"

printf 'Sicherung erstellt: %s\n' "$target/database.sql.gz"
