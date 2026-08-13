# ClubIQ Music Voting

ClubIQ Music ist die lokale Musikwunsch- und Abstimmungs-App für den Vereinsbetrieb. Die Bedienoberfläche, Anmeldung, Abstimmungen und lokale Soundboard-Clips laufen vollständig vom Raspberry. Die YouTube-Suche und das Abspielen von YouTube-Songs benötigen Internet.

## Bedienung

- Neue Mitglieder registrieren sich mit ihrem Namen und einer selbst gewählten PIN. Bereits vorhandene Namen können nicht erneut registriert werden.
- Die geschützte Verwaltung kann Mitglieder weiterhin anlegen, sperren und vergessene PINs zurücksetzen.
- Nach der Anmeldung zeigt die App das verbleibende Punktebudget an.
- Punkte können je Song erhöht, reduziert oder vollständig entfernt werden.
- „Meine Auswahl“ fasst die eigenen Stimmen nachvollziehbar zusammen.
- Abstimmungen werden mit genauer Start- und Endzeit geplant und durch einen Live-Countdown begleitet.
- Die öffentliche Rangliste bleibt ohne Anmeldung sichtbar; zum Vergeben eigener Punkte ist weiterhin eine Anmeldung nötig.
- YouTube-Suchergebnisse und gespeicherte YouTube-Songs erhalten Vorschaubilder, wenn Internet verfügbar ist.
- Die Verwaltung trennt Abstimmungen, Mitglieder und den aktuellen Stimmenstand.
- Der zentrale Raspberry-Player spielt die Rangliste über eine verbundene Bluetooth-Box ab.
- Angemeldete Mitglieder können Wiedergabe, Lautstärke, Warteschlange und Soundboard bedienen.
- Bluetooth-Boxen werden ausschließlich in der geschützten ClubIQ-Oberfläche gesucht, gekoppelt und getrennt.

Bestehende Mitglieder ohne PIN können beim ersten Login nach dem Update einmalig ihre PIN festlegen. Bei einer neuen Registrierung muss die PIN zur Kontrolle zweimal eingegeben werden. Danach wird nur noch der gesalzene PBKDF2-Hash gespeichert. Anmeldesitzungen laufen standardmäßig nach 30 Tagen ab und werden serverseitig validiert.

Lokales Music-Voting-System für den Raspberry Pi. Webanwendung und PostgreSQL laufen getrennt in Docker-Containern. Die Datenbank wird nicht nach außen veröffentlicht.

Eine transparente Aktivitätsliste zeigt Beteiligung an Voting, Vorschlägen und
Player-Bedienung. Im geschützten DJ-Modus kann die Verwaltung Songs suchen,
direkt einreihen, verschieben, sofort abspielen und entfernen. Die genaue Bedienung
steht in [DJ, Warteschlange und Aktivitätsliste](docs/DJ-UND-AKTIVITAET.md).

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

## Zentralen Bluetooth-Player einrichten

Die Box wird nicht mit dem Tablet gekoppelt. Der Raspberry ist der einzige Audioplayer;
alle Tablets sind lediglich sichere Fernbedienungen. Dadurch bleibt die Musik auch bei
einem geschlossenen Tablet-Browser aktiv.

Nach dem normalen Docker-Start einmal ausführen:

```bash
cd ~/clubiq_music_release
sudo ./scripts/install-player.sh
sudo systemctl status clubiq-music-player --no-pager
```

Danach in **Verwaltung → Player & Box**:

1. Bluetooth-Box in den Kopplungsmodus setzen.
2. „Boxen suchen“ wählen.
3. Bei der gewünschten Box „Verbinden“ wählen.

ClubIQ vertraut der Box anschließend und versucht nach Abbrüchen oder Neustarts alle
15 Sekunden automatisch, die Verbindung wiederherzustellen. Diagnose:

```bash
sudo journalctl -u clubiq-music-player -n 100 --no-pager
sudo bluetoothctl paired-devices
```

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
