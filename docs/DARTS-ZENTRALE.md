# Darts-Zentrale

Die Route `/darts` zeigt die offiziellen 3K-Ansichten für SV Barver Darts A–D. Im Player führt „Darts-Zentrale · A–D“ in einem neuen Tab dorthin. Keine Veränderung der Musikwiedergabe.

Der öffentliche Host `barverdarts.clubiq.party` liefert am Pfad `/` direkt die Darts-Zentrale aus. Andere Hosts – insbesondere `musik.clubiq.party` – behalten am Pfad `/` die Musik-App. Der Musik-Link in der Darts-Kopfzeile verwendet deshalb die feste Adresse `https://musik.clubiq.party/`.

## Teams 2026 / 2027

| Team | Wettbewerb | 3K-Mannschaft |
| --- | --- | --- |
| A | Kreisligen 04, Event 1445 | 174110 |
| B | Kreisligen 04, Event 1445 | 174111 |
| C | Kreisligen 04, Event 1445 | 174112 |
| D | Kreisklasse 11, Event 1460 | 174266 |

Die Links wurden am 20.09.2026 im öffentlichen Portal geprüft. Nach einem Saisonwechsel müssen diese festen Zuordnungen geprüft werden.

## Darstellung und Werbepartner

Der Umschalter „Hell / Dunkel“ in der Kopfzeile wechselt das Farbschema. Die Auswahl wird ausschließlich im Browser des jeweiligen Geräts gespeichert; beim ersten Besuch gilt die Systemeinstellung.

Die zwei optionalen Werbeflächen werden aus `static/darts-sponsors.json` geladen. Ist kein aktuell gültiger Eintrag vorhanden, bleiben beide Flächen vollständig ausgeblendet. Logos werden lokal unter `pics/sponsors/` abgelegt, damit beim bloßen Seitenaufruf keine Verbindung zu Werbepartnern entsteht. Ein externer HTTPS-Link wird erst beim Anklicken geöffnet.

Beispielkonfiguration:

```json
{
  "displaySeconds": 12,
  "sponsors": [
    {
      "id": "musterbetrieb",
      "name": "Musterbetrieb Barver",
      "image": "/pics/sponsors/musterbetrieb.png",
      "href": "https://www.example.com/",
      "placements": ["top", "inline"],
      "startsAt": "2026-10-01T00:00:00+02:00",
      "endsAt": "2027-09-30T23:59:59+02:00"
    }
  ]
}
```

`displaySeconds` liegt technisch zwischen 6 und 60 Sekunden. `placements` kann `top`, `inline` oder beide Werte enthalten. Fehlen Start oder Ende, ist die entsprechende Seite des Zeitraums offen. Ungültige, abgelaufene oder noch nicht begonnene Einträge werden nicht angezeigt. Mehrere gültige Firmen wechseln automatisch; die beiden Positionen starten versetzt.

## Push-Benachrichtigungen für 180er

„Push aktivieren“ fordert erst nach dem bewussten Klick die Browser-Berechtigung an. Anschließend meldet das Gerät neu erkannte 180er und High Finishes, gewonnene Legs, Endstände der Einzel-/Doppelpartien sowie den Mannschafts-Endstand. Ein erneuter Klick schaltet Push auf diesem Gerät wieder aus. ClubIQ speichert nur die technische Push-Adresse, deren Verschlüsselungsschlüssel und die Auswahl A–D – keine Browserchronik und keine Kontaktdaten.

Der Server prüft 3K alle 45 Sekunden. Spieler- und Partieereignisse werden nur aus einer von 3K als laufend gemeldeten Begegnung versendet. Ein Mannschafts-Endstand muss frisch gemeldet sein. Beim Start wird der vorhandene Stand zunächst nur eingelesen; ältere Spielberichte lösen dadurch keine verspätete Meldungsflut aus. Eine Ereignis-ID verhindert doppelte Meldungen auch nach einem Neustart. Abgelaufene Browser-Abonnements werden bei einer Antwort 404/410 automatisch entfernt. Die Browser-Pushadresse ist ein Geheimnis und wird weder protokolliert noch an andere Nutzer ausgegeben.

Für die Ersteinrichtung einmal `scripts/generate-vapid.py /pfad/zur/.env` innerhalb des gebauten Web-Images ausführen und danach den Webdienst neu erstellen. Der private VAPID-Schlüssel bleibt ausschließlich in der lokalen `.env` und gehört in das verschlüsselte Notfall-Backup. Auf iPhone und iPad muss die Darts-Zentrale als Web-App zum Home-Bildschirm hinzugefügt werden, bevor Web Push angeboten wird.

## Bedienung

Das Laufband „3K Aktuell“ wird alle 30 Sekunden aus den öffentlichen 3K-Spielplänen aktualisiert. Es zeigt laufende Zwischenstände zuerst, danach die nächsten Begegnungen und zuletzt abgeschlossene Ergebnisse. Bei einer Störung bleibt der letzte erfolgreiche Stand gekennzeichnet erhalten; personenbezogene Kontaktdaten aus 3K werden nicht übernommen.

Das kompakte Matchcenter darunter zeigt für Barver A–D jeweils den wichtigsten aktuellen Eintrag: laufende Begegnungen zuerst, danach das nächste Spiel oder das letzte Ergebnis. Auf dem Handy sind die vier Karten horizontal durchwischbar.

1. „Gleichzeitig anzeigen“ wählt 1–4 Fenster. Die Team-Schaltflächen passen die Auswahl an; „Auswahl anzeigen“ lädt die ausgewählten 3K-Fenster.
2. „Groß“ zeigt ein Team. Auf kleinen Displays stehen mehrere Fenster lesbar untereinander. Auswahl, Anzahl und Ansichten werden auf diesem Gerät gespeichert. „Meine Auswahl beim Öffnen automatisch laden“ erlaubt ausdrücklich das automatische Laden von 3K beim nächsten Besuch; standardmäßig ist es aus.
3. „Spiel wählen“: Link der konkreten Begegnung aus dem 3K-Portal einfügen (`?matchId=…`) oder den passenden Link von `live.3k-darts.com/event/10/…`. Die Auswahl gilt nur auf diesem Gerät, nicht vereinsweit.
4. Zwischen Mannschaftsübersicht, gespeichertem Spielbericht und Live-Ansicht wechseln. Bei einem reinen Live-Link gibt es keinen abgeleiteten Spielbericht-Link.
5. „Neu laden“ aktualisiert das betreffende Fenster. „Bei 3K öffnen“ dient als Ausweichmöglichkeit, wenn Einbettung, Internet oder Browser Probleme machen.

Keine automatische Ermittlung des nächsten Spiels: Es gibt keine öffentliche Ergebnis-API. Ein gespeicherter Match-Link wechselt nicht selbständig zum nächsten Spieltag. Insbesondere A, B und C sind in derselben Liga – ihre Begegnungszuordnung muss der Anwender prüfen.

## Training

Über „Training“ wird ein separater Bereich geöffnet. Das verifizierte Beispiel ist Event 31849 („Training Doppel 10.09.“), Gruppe 403948 in Phase 53660. Teilnehmer, Bestleistungen und Platzierungen sind direkt wählbar; Spiele & Tabelle benötigen den Gruppenlink. Andere Trainings im 3K-Mandanten 5 können über einen validierten Portal-Link ausgewählt werden. Die Auswahl wird ausschließlich auf diesem Gerät unter `clubiq_darts_training` gespeichert. Keine Fremdverbindung vor dem Anzeigen/Übernehmen oder dem Wechsel einer Ansicht.

Training bleibt bewusst als offizielle 3K-Ansicht eingebettet. Die native ClubIQ-Sportansicht und die 180er-Meldungen verwenden ausschließlich die öffentlich erreichbaren Sportdaten der fest hinterlegten Barver-Ligen. ClubIQ greift weder auf Konten noch auf interne 3K-Funktionen zu und umgeht keine Anmeldung. Fällt die öffentliche Quelle aus oder ändert 3K deren Aufbau, bleibt die offizielle Ansicht die Ausweichmöglichkeit.

## Aktuelles von SV Barver

Die öffentliche Veranstalterübersicht `https://portal.3k-darts.com/frontend/events/5/mandant/1931` ist unter „Aktuelles“ eingebunden. Sie wird von 3K gepflegt und enthält neue Trainings, Turniere und andere Veranstaltungen von SV Barver, ohne dass ClubIQ pro Veranstaltung einen neuen Link benötigt. „Aktualisieren“ lädt die Übersicht neu; ClubIQ liest oder speichert dabei keine fremden Veranstaltungsdaten. Falls die Einbettung vom Browser blockiert wird, führt „Bei 3K öffnen“ zur gleichen offiziellen Übersicht.

Prüfstatus: URL- und Sicherheitstests bestanden; lokale Trainingsnavigation und Auswahl des korrekten Bestleistungslinks im Browser geprüft. Externe iFrames bleiben im verfügbaren In-App-Testbrowser leer; erfolgreiche Einbettung ist daher noch nicht bestätigt. „Bei 3K öffnen“ ist die Ausweichmöglichkeit. Die erste Veröffentlichung erfolgt auf Benutzerwunsch mit dieser Einschränkung; zusätzlich im normalen Vereinsbrowser prüfen.

## Offizielle Einbettung

3K beschreibt iFrame-Einbettung offiziell unter https://2k-dartsoftware.freshdesk.com/support/solutions/articles/103000362922-schnittstelle-api-einbindung-in-webseiten . Kopfzeile, Werbung, Aktualisierungsverhalten und Darstellung stammen von 3K und werden nicht verändert oder ausgelesen. Live-Daten sind nur bei aktiver Übertragung vorhanden; ein geladenes Fenster ist kein Nachweis einer Live-Verbindung.

Nur `/darts` erlaubt die beiden exakten 3K-Hosts als Frame-Quellen. Andere Seiten behalten ihre bisherigen Frame-Regeln. Die eingebetteten Fenster dürfen die ClubIQ-Seite nicht navigieren oder deren Daten lesen. Keine serverseitigen Abrufe beliebiger Links, keine Zugangsdaten und keine automatische Ergebnisübernahme.

Test: `node tests/test_darts.cjs`. Isolierte Vorschau ohne Datenbank/Player: `node scripts/preview-darts.cjs`.
