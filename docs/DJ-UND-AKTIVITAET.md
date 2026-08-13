# DJ, Warteschlange und Aktivitätsliste

## Aktivste Mitglieder

Unter **Voting → Aktivste Mitglieder** zeigt ClubIQ, wer sich in der laufenden
Abstimmung beteiligt. Die Liste ist bewusst keine reine Punkteliste:

- 2 Aktivitätspunkte je bewertetem Song
- 3 Aktivitätspunkte je freigegebenem Songvorschlag
- 1 Aktivitätspunkt je sinnvoller Player-Aktion, höchstens 10 pro Abstimmung

So zählt regelmäßige Beteiligung, ohne dass ein Mitglied durch sehr viele Punkte
auf nur einen Song automatisch gewinnt. Die Liste aktualisiert sich alle 30 Sekunden.

## Tatsächliche Wiedergabereihenfolge

Unter **Player** sehen alle Mitglieder die Reihenfolge, die wirklich am Raspberry
abgespielt wird:

- **Jetzt** markiert den aktuellen Song.
- **Als Nächstes** markiert den folgenden Song.
- Bereits gespielte Titel bleiben abgeblendet als kurzer Verlauf sichtbar.
- Manuell ergänzte Titel sind mit **DJ** gekennzeichnet.

Ein angemeldetes Mitglied kann mit **Playlist erstellen & abspielen** die festgelegte
Playlist in den Player übernehmen. Dadurch wird eine vorhandene Warteschlange ersetzt.

## Automatische Playlist-Auffüllung

ClubIQ baut die Liste immer in dieser festen Reihenfolge:

1. Songs mit Stimmen aus der aktuellen Abstimmung, nach Punkten sortiert
2. noch fehlende Songs aus der zuletzt tatsächlich erzeugten ClubIQ-Playlist
3. noch fehlende populäre Songs aus dem eingestellten Genre

Doppelte YouTube-Titel werden automatisch entfernt. Die fertige Liste wird bei der
Abstimmung gespeichert und kann bei der nächsten Veranstaltung als zweite Stufe
verwendet werden. Die YouTube-Genre-Suche wird zwölf Stunden zwischengespeichert,
damit das API-Kontingent nicht durch wiederholtes Laden verbraucht wird.

Die Regeln stehen unter **Verwaltung → Abstimmungen**. Beim Erstellen oder später
unter **Playlist-Regeln bearbeiten** lassen sich je Abstimmung einstellen:

- Zielgröße von 1 bis 50 Songs
- vorherige Playlist verwenden: an/aus
- Genre-Auffüllung: an/aus
- Genre, zum Beispiel Party, Rock, Schlager oder 90er

Sind genügend aktuelle Voting-Songs vorhanden, werden keine älteren oder automatisch
gesuchten Titel ergänzt. Ist die YouTube-Suche nicht eingerichtet oder vorübergehend
nicht erreichbar, bleiben die ersten beiden Stufen funktionsfähig.

## DJ-Modus verwenden

1. **Verwaltung** öffnen und das Verwaltungspasswort eingeben.
2. **Player & Box** auswählen.
3. Im Abschnitt **DJ-Modus** nach Titel oder Interpret suchen.
4. Beim gewünschten Treffer wählen:
   - **Als Nächstes** fügt den Song direkt hinter dem laufenden Titel ein.
   - **Ans Ende** hängt ihn an die Warteschlange an.
5. In **Reihenfolge bearbeiten** stehen folgende Aktionen bereit:
   - **Jetzt** spielt den gewählten Titel sofort.
   - **↑ / ↓** verschiebt ihn um eine Position.
   - **Entfernen** nimmt ihn nach einer Sicherheitsabfrage aus der Liste.

Die Warteschlange wird auf dem Raspberry gespeichert und bleibt deshalb bei einem
Neuladen des Tablets erhalten.

## Update auf dem Raspberry

Da sich Web-App und lokaler Player-Dienst ändern, müssen beide aktualisiert werden:

```bash
cd ~/clubiq_music_release
sudo env BACKUP_DIR=/mnt/vereinskasse-sicherung/clubiq-music ./scripts/backup.sh
git pull --ff-only origin main
sudo ./scripts/install-player.sh
sudo docker compose build --pull web
sudo docker compose up -d --force-recreate --wait --wait-timeout 120
curl --fail http://127.0.0.1:8000/health
sudo systemctl status clubiq-music-player --no-pager
```

Danach die ClubIQ-Seite auf dem Tablet einmal vollständig neu laden. Durch die
Versionskennung an CSS und JavaScript wird die neue Oberfläche anschließend ohne
alten Browser-Cache geladen.
