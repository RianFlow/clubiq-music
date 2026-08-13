#!/bin/sh
set -eu

interval="${MUSIC_BACKUP_INTERVAL_SECONDS:-21600}"
retention="${MUSIC_BACKUP_RETENTION_DAYS:-30}"
archive_dir=/backups/archive
usb_dir=/backups/usb/clubiq-music
status_file=/backups/status.json

mkdir -p "$archive_dir"

write_status() {
  ok="$1"
  message="$2"
  archive="${3:-}"
  size="${4:-0}"
  usb="${5:-false}"
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  temp_status="${status_file}.tmp"
  printf '{"ok":%s,"finished_at":"%s","message":"%s","archive":"%s","size_bytes":%s,"usb_copied":%s}\n' \
    "$ok" "$finished" "$message" "$archive" "$size" "$usb" > "$temp_status"
  chmod 0644 "$temp_status"
  mv "$temp_status" "$status_file"
}

while true; do
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  base="clubiq-music-${stamp}"
  sql_temp="${archive_dir}/${base}.sql.tmp"
  archive="${archive_dir}/${base}.sql.gz"
  usb_copied=false

  rm -f "$sql_temp" "$archive"
  if pg_dump --clean --if-exists --no-owner --no-privileges --file="$sql_temp" \
      && gzip -9 -c "$sql_temp" > "$archive" \
      && rm -f "$sql_temp" \
      && gzip -t "$archive" \
      && zgrep -q 'CREATE TABLE' "$archive"; then
    sha256sum "$archive" > "${archive}.sha256"
    size="$(wc -c < "$archive" | tr -d ' ')"
    if [ -f /backups/usb/.clubiq-backup-target ]; then
      mkdir -p "$usb_dir"
      cp "$archive" "${archive}.sha256" "$usb_dir/"
      usb_copied=true
    fi
    find "$archive_dir" -type f -mtime "+$retention" -delete 2>/dev/null || true
    if [ -d "$usb_dir" ]; then
      find "$usb_dir" -type f -mtime "+$retention" -delete 2>/dev/null || true
    fi
    write_status true "Automatische PostgreSQL-Sicherung erfolgreich" "$base.sql.gz" "$size" "$usb_copied"
    echo "ClubIQ Music Sicherung geprüft: $archive"
  else
    rm -f "$sql_temp" "$archive"
    write_status false "Automatische PostgreSQL-Sicherung fehlgeschlagen"
    echo "ClubIQ Music Sicherung fehlgeschlagen" >&2
  fi

  sleep "$interval"
done
