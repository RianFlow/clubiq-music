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

ClubIQ wartet beim Koppeln, Vertrauen und Verbinden auf die jeweilige Rückmeldung
von BlueZ. Bereits gekoppelte Boxen werden nicht erneut gekoppelt. Der Status und
Fehler bleiben direkt unter der Boxenliste sichtbar, auch im Verwaltungsfenster.
Währenddessen bitte keine zweite Verbindung starten und die Box nicht mit dem
Handy verbinden. Bei einem Fehler steht dabei, welcher Schritt gescheitert ist.

ClubIQ versucht nach Abbrüchen oder Neustarts regelmäßig, die Verbindung
wiederherzustellen. Diagnose:

```bash
sudo journalctl -u clubiq-music-player -n 100 --no-pager
sudo bluetoothctl devices Paired
```

Bei `NotReady` zuerst `rfkill list bluetooth` prüfen. Eine Softwaresperre lässt sich
mit `sudo rfkill unblock bluetooth` lösen; danach `sudo bluetoothctl power on`.
Bei `AuthenticationFailed` den Kopplungsmodus der Box und eine bestehende
Handy-Verbindung prüfen. Bei `br-connection-profile-unavailable` den Dienst mit
`systemctl status bluealsa --no-pager` prüfen.

Wenn ein Update `player_agent.py` ändert, reicht ein Docker-Neustart nicht:
nach dem Aktualisieren auch `sudo ./scripts/install-player.sh` ausführen. Dieses
installiert den Player-Dienst auf dem Raspberry erneut; gespeicherte Kopplungen
und Einstellungen werden dabei nicht gelöscht.

Technische Grundlage: [BlueZ bluetoothctl](https://github.com/bluez/bluez/blob/5.82/client/main.c)
(Einzelbefehle mit Rückmeldung und zeitlich begrenztem Pairing-Agenten) und
[modale Browser-Ebene](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer).

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

Zusätzlich erstellt der Docker-Dienst `backup` automatisch alle sechs Stunden eine
geprüfte PostgreSQL-Sicherung. Ist der gemeinsame USB-Stick mit der Markierung
`.clubiq-backup-target` eingehängt, wird dort eine zweite Kopie abgelegt.

## PWA, DJ-Fernbedienung und Party-Anzeige

- Haupt-App: `/`
- kompakte DJ-Steuerung: `/remote`
- Vollbildanzeige für einen zweiten Bildschirm: `/party`

Die PWA wird über das Browsermenü oder die Schaltfläche `App installieren`
installiert. Dafür muss ClubIQ Music über HTTPS geöffnet sein. Es wird nur die
Bedienoberfläche zwischengespeichert, keine Online-Musik.

## Player-Freigaben und Internetradio

Player-Befehle sind für normale Mitglieder standardmäßig gesperrt. In
**Verwaltung → Mitglieder** kann ein Admin mit **Player freigeben** einzelne
Mitglieder berechtigen. Diese Freigabe wird bei jedem schreibenden API-Aufruf
serverseitig geprüft; Abstimmen und Vorschlagen bleiben davon unabhängig.

Unter **Verwaltung → Player & Box → Radiosender suchen** reicht ein Stichwort
wie **NDR 2**, **ffn**, **Rock** oder **Schlager**. Die Suche fragt Sendernamen und
Musikrichtungen im freien [Radio-Browser-Verzeichnis](https://www.radio-browser.info/)
ab. Mit **Hinzufügen** wird die Stream-Adresse automatisch gespeichert; anschließend
unten in der Senderliste **Abspielen** wählen. Doppelte Importe werden abgefangen.
Auch ein Admin muss zum Verwalten von Sendern im Verwaltungsbereich angemeldet sein.

Für Suche und Wiedergabe benötigt der Raspberry Internet; das Tablet darf im
Kassen-WLAN bleiben. Ein Verzeichnisausfall verhindert nicht den Start bereits
gespeicherter Sender. Sender können ihre Streams ändern oder zeitweise ausfallen.
Die Suche verwendet das zuletzt als erreichbar markierte Angebot des Verzeichnisses,
das ist keine Garantie für eine unterbrechungsfreie Wiedergabe.

Unter **Eigene Stream-Adresse eingeben (optional)** bleiben direkte MP3-, AAC-
oder HLS-Adressen und ein Ersatz-Stream möglich. Freigeschaltete Mitglieder wechseln im Player
zwischen Playlist und Radio; die Party-Anzeige übernimmt Sender und verfügbare
Titelinformationen automatisch.

Senderlogos werden über den Raspberry geladen und für sechs Stunden zwischengespeichert,
damit sie auch bei reinem HTTP-Bildangebot auf der HTTPS-Seite erscheinen. Es werden nur
kleine Rasterbilder von öffentlichen Adressen geladen; interne Netzadressen, ungeprüfte
Weiterleitungen, SVG- und HTML-Inhalte werden abgewiesen. Ist ein Logo beim Anbieter
gesperrt oder fehlt es, erscheint ein Radio-Symbol statt eines kaputten Bildes. Die
Fehlgeschlagene Abrufe werden nach fünf Minuten beim nächsten Laden erneut geprüft. Das gilt auch für Player,
Fernbedienung und Party-Anzeige; die Sicherheitsrichtlinie der App bleibt unverändert.

Technik: [Radio-Browser-API](https://docs.radio-browser.info/), Suchcache fünf Minuten,
begrenzte Netzwerkwartezeit, kein API-Schlüssel erforderlich. Bei einem Serverwechsel
kann `RADIO_BROWSER_BASE_URL` in der `.env` auf einen aktuellen offiziellen API-Server
gesetzt werden. Der native Player nutzt die auf mpv 0.40 verfügbare Option
`--audio-fallback-to-null=no`; ein Ausfall der Box wird nicht durch stumme Ausgabe kaschiert.
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
