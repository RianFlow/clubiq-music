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

## Bedienung

1. „Gleichzeitig anzeigen“ wählt 1–4 Fenster. Die Team-Schaltflächen passen die Auswahl an; „Auswahl anzeigen“ lädt die ausgewählten 3K-Fenster.
2. „Groß“ zeigt ein Team. Auf kleinen Displays stehen mehrere Fenster lesbar untereinander. Auswahl, Anzahl und Ansichten werden auf diesem Gerät gespeichert. „Meine Auswahl beim Öffnen automatisch laden“ erlaubt ausdrücklich das automatische Laden von 3K beim nächsten Besuch; standardmäßig ist es aus.
3. „Spiel wählen“: Link der konkreten Begegnung aus dem 3K-Portal einfügen (`?matchId=…`) oder den passenden Link von `live.3k-darts.com/event/10/…`. Die Auswahl gilt nur auf diesem Gerät, nicht vereinsweit.
4. Zwischen Mannschaftsübersicht, gespeichertem Spielbericht und Live-Ansicht wechseln. Bei einem reinen Live-Link gibt es keinen abgeleiteten Spielbericht-Link.
5. „Neu laden“ aktualisiert das betreffende Fenster. „Bei 3K öffnen“ dient als Ausweichmöglichkeit, wenn Einbettung, Internet oder Browser Probleme machen.

Keine automatische Ermittlung des nächsten Spiels: Es gibt keine öffentliche Ergebnis-API. Ein gespeicherter Match-Link wechselt nicht selbständig zum nächsten Spieltag. Insbesondere A, B und C sind in derselben Liga – ihre Begegnungszuordnung muss der Anwender prüfen.

## Training

Über „Training“ wird ein separater Bereich geöffnet. Das verifizierte Beispiel ist Event 31849 („Training Doppel 10.09.“), Gruppe 403948 in Phase 53660. Teilnehmer, Bestleistungen und Platzierungen sind direkt wählbar; Spiele & Tabelle benötigen den Gruppenlink. Andere Trainings im 3K-Mandanten 5 können über einen validierten Portal-Link ausgewählt werden. Die Auswahl wird ausschließlich auf diesem Gerät unter `clubiq_darts_training` gespeichert. Keine Fremdverbindung vor dem Anzeigen/Übernehmen oder dem Wechsel einer Ansicht.

Die offizielle 3K-Dokumentation bestätigt am 20.09.2026 ausdrücklich, dass keine öffentliche API angeboten wird. Eine eigene Darstellung mit automatisch erkannten 180-/Leg-Sieg-Ereignissen und eine automatische Auswahl der nächsten Begegnung sind deshalb nicht implementiert. Dafür ist eine abgestimmte Datenschnittstelle mit 3K erforderlich. Keine internen Endpunkte, kein Scraping und keine Umgehung der fremden Oberfläche.

## Aktuelles von SV Barver

Die öffentliche Veranstalterübersicht `https://portal.3k-darts.com/frontend/events/5/mandant/1931` ist unter „Aktuelles“ eingebunden. Sie wird von 3K gepflegt und enthält neue Trainings, Turniere und andere Veranstaltungen von SV Barver, ohne dass ClubIQ pro Veranstaltung einen neuen Link benötigt. „Aktualisieren“ lädt die Übersicht neu; ClubIQ liest oder speichert dabei keine fremden Veranstaltungsdaten. Falls die Einbettung vom Browser blockiert wird, führt „Bei 3K öffnen“ zur gleichen offiziellen Übersicht.

Prüfstatus: URL- und Sicherheitstests bestanden; lokale Trainingsnavigation und Auswahl des korrekten Bestleistungslinks im Browser geprüft. Externe iFrames bleiben im verfügbaren In-App-Testbrowser leer; erfolgreiche Einbettung ist daher noch nicht bestätigt. „Bei 3K öffnen“ ist die Ausweichmöglichkeit. Die erste Veröffentlichung erfolgt auf Benutzerwunsch mit dieser Einschränkung; zusätzlich im normalen Vereinsbrowser prüfen.

## Offizielle Einbettung

3K beschreibt iFrame-Einbettung offiziell unter https://2k-dartsoftware.freshdesk.com/support/solutions/articles/103000362922-schnittstelle-api-einbindung-in-webseiten . Kopfzeile, Werbung, Aktualisierungsverhalten und Darstellung stammen von 3K und werden nicht verändert oder ausgelesen. Live-Daten sind nur bei aktiver Übertragung vorhanden; ein geladenes Fenster ist kein Nachweis einer Live-Verbindung.

Nur `/darts` erlaubt die beiden exakten 3K-Hosts als Frame-Quellen. Andere Seiten behalten ihre bisherigen Frame-Regeln. Die eingebetteten Fenster dürfen die ClubIQ-Seite nicht navigieren oder deren Daten lesen. Keine serverseitigen Abrufe beliebiger Links, keine Zugangsdaten und keine automatische Ergebnisübernahme.

Test: `node tests/test_darts.cjs`. Isolierte Vorschau ohne Datenbank/Player: `node scripts/preview-darts.cjs`.
