# Turnier-Live und TV

## Nächstes Turnier auswählen

1. `/darts-admin` mit dem bestehenden Verwaltungskennwort öffnen.
2. Den Bereich **Turniere** auswählen.
3. Öffentlichen 3K-Turnierlink einfügen, etwa eine Teilnehmer- oder Gruppenadresse.
4. **Turnier prüfen**: Name und Datum kontrollieren.
5. **Für Live & TV aktivieren** und bestätigen.

Die Auswahl wird in PostgreSQL gespeichert und überlebt Neustarts. Die öffentlichen
Adressen bleiben `/turnier` und `/turnier?tv=1`. Einzel- und Doppelturniere haben
jeweils einen eigenen 3K-Link. Veranstaltungsbanner sind davon unabhängig.
Aktuell werden die bekannten öffentlichen 3K-Bereiche 5 und 10 unterstützt.
Andere Bereiche werden mit einer Meldung abgelehnt, nicht über einen geratenen Server geladen.

## Tabellenanzeige

- **Neben den Boards**: Eine Gruppentabelle bleibt neben den laufenden Spielen sichtbar.
- **Im Wechsel**: Im TV-Modus wechseln Boards und eine große Tabelle alle 20 Sekunden.
- **Gruppen & Tabellen**: Nur Tabellen anzeigen; auf der normalen Seite alle Gruppen.
- Gruppen manuell auswählen oder alle automatisch durchlaufen lassen.
- Tabellen mit mehr als acht Teilnehmern bekommen zusätzliche Seiten.
- Die Reihenfolge stammt unverändert aus 3K; kein eigener Ranglistenalgorithmus.
- Die Board-Seiten wechseln alle zwölf Sekunden. Beides lässt sich pausieren.
- Der Server teilt einen 15-Sekunden-Cache zwischen Zuschauern und hält bei Störungen
  den letzten bekannten Stand des **gleichen** Turniers bereit.

## Lokale Demo

`node tests/test_darts_tournament_browser.cjs --serve` startet ausschließlich auf
127.0.0.1. Die ausgegebene Adresse mit `?tv=1&demo=tournament` zeigt bewegliche,
ausdrücklich fiktive Beispielstände. Auf öffentlichen Hosts wird dieser Demo-Schalter
ignoriert. Es gibt keine Verbindung zu Live-Daten, Push-Abonnements oder Musiksteuerung.

Die zugehörige Verwaltungsdemo verwendet das Kennwort `demo` und nur flüchtige
Testdaten. Das ist **kein** Produktionskennwort.

## Liga und Pokal

Ein noch nicht offiziell abgeschlossenes Ligaspiel wird acht Stunden nach der
gemeldeten Anwurfzeit **vorläufig beendet** angezeigt, mit dem Vermerk
**Bestätigung durch den Veranstalter ausstehend**. Das ist kein bestätigter Endstand
und erzeugt weder einen Gewinner noch eine Endstand-Pushmeldung. Frische aktive
Boarddaten haben Vorrang. Die offizielle Beendigung ersetzt den Hinweis automatisch.

Ein leerer Überwachungskanal gilt nicht als Live-Spiel. Alte Kanäle werden aus der
Live-Beobachtung genommen. Der Pokal-Menüpunkt verschwindet erst, wenn für alle
vier Barver-Teams die jeweils letzte bekannte Pokalbegegnung eine bestätigte
Niederlage ist. Bei fehlenden oder veralteten Informationen bleibt er vorsorglich sichtbar.
Historische Pokalergebnisse bleiben im Saisonspielplan erhalten.
