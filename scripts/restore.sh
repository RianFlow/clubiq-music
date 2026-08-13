#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Verwendung: scripts/restore.sh /pfad/database.sql.gz" >&2
  exit 2
fi

archive="$1"
[ -f "$archive" ] || { echo "Sicherung nicht gefunden: $archive" >&2; exit 2; }
gzip -t "$archive"
gzip -dc "$archive" | grep -q 'CREATE TABLE'

printf 'ACHTUNG: Die aktive Music-Voting-Datenbank wird ersetzt. RESTORE eingeben: '
read -r confirmation
[ "$confirmation" = "RESTORE" ] || { echo "Abgebrochen."; exit 1; }

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

gzip -dc "$archive" | docker compose exec -T db sh -ec \
  'psql --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"'

echo "Wiederherstellung abgeschlossen."
