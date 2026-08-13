# ClubIQ Music Voting

Lokales Music-Voting-System für den Raspberry Pi. Webanwendung und PostgreSQL laufen getrennt in Docker-Containern. Die Datenbank wird nicht nach außen veröffentlicht.

## Voraussetzungen

- Docker Engine mit Compose-Plugin
- Git
- Raspberry Pi oder Linux-Server

## Ersteinrichtung

```bash
git clone https://github.com/RianFlow/clubiq-music.git
cd clubiq-music
cp .env.example .env
nano .env
docker compose up -d --build --wait
```

Falls bestehende Skripte feste Containernamen erwarten, verwende stattdessen immer die stabilen Dienstnamen `web` und `db`, zum Beispiel `docker compose logs web`.

In `.env` müssen mindestens sichere Werte für `DB_PASSWORD` und `ADMIN_PASSWORD` gesetzt werden. `.env` ist von Git und vom Docker-Build ausgeschlossen.

Die Anwendung ist anschließend standardmäßig unter `http://SERVER-IP:8000` erreichbar.

## Zustand prüfen

```bash
docker compose ps
curl --fail http://127.0.0.1:8000/health
docker compose logs --tail=100 web db
```

Beide Container besitzen Healthchecks und starten nach einem Neustart automatisch wieder.

## Aktualisieren

Updates werden absichtlich nicht über einen öffentlichen Web-Endpunkt ausgeführt:

```bash
git pull --ff-only origin main
docker compose build --pull web
docker compose up -d --wait
```

Vor jedem Update zuerst eine Sicherung erstellen.

## Sicherung

Standardmäßig landet die Sicherung unter `./backups`. Für den ClubIQ-USB-Stick:

```bash
sudo env BACKUP_DIR=/mnt/vereinskasse-sicherung/clubiq-music ./scripts/backup.sh
```

Die Sicherung wird komprimiert, inhaltlich geprüft und mit SHA-256 versehen.

## Wiederherstellung

```bash
sudo ./scripts/restore.sh /pfad/zur/database.sql.gz
```

Vor dem Überschreiben verlangt das Skript ausdrücklich die Eingabe `RESTORE`.

## Sicherheitsregeln

- PostgreSQL hat keinen Host-Port.
- `.env`, Schlüssel, Logs und Sicherungen gehören nie ins Repository oder Image.
- Verwaltungs- und Player-Aufrufe benötigen `ADMIN_PASSWORD`.
- Der frühere ungeschützte Quick-Tunnel wurde entfernt.
- Externer Zugriff sollte ausschließlich kontrolliert über Tailscale oder einen authentifizierten Reverse Proxy erfolgen.
