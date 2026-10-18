# Mannschaftsspiele auf dem Server überwachen

`TeamMatchWatch` läuft im bestehenden Server-Scheduler unabhängig von Besuchern.
Es benötigt keinen PC, keine neue externe API und keinen zusätzlichen Browser.
Die bekannten 3K-Spiel-IDs von Barver A bis D werden gezielt weiterverfolgt.

## Ablauf

- Spielplan normalerweise alle fünf Minuten, ab 30 Minuten vor einem Termin alle
  30 Sekunden aus dem vorhandenen Datenzugang lesen. Der Collector aktualisiert
  die zugrunde liegenden Spielpläne weiterhin unabhängig alle fünf Minuten.
- Je Begegnung bestehende 3K-Live-Verbindung nutzen: vor dem Start zusätzlich alle
  30 Sekunden REST-Abgleich, während des Spiels alle sieben Sekunden. Fehlerhafte
  Verbindungen mit begrenztem Abstand wiederherstellen.
- Bekannte Termine überstehen unvollständige Listen und fehlgeschlagene Abrufe.
  Explizite neue Termine ersetzen den alten Ansatz. Unbestätigte Termine werden
  spätestens acht Stunden nach dem Ansatz aus der Überwachung genommen.
- Zustände: nächster Termin, auf Live-Daten warten, live, Verbindung unterbrochen,
  beendet. Ein siebter gewonnener Punkt löst weiter die Siegmeldung aus, beendet
  aber keine Begegnung mit zwölf Einzel-/Doppelpartien.
- Erst bestätigter Gesamtabschluss startet die zehnminütige Zusammenfassung.
  Zeitpunkt und Endstand bleiben auch nach Neustart erhalten.

## Speicherung und gemeinsame Anzeige

Die normalisierten öffentlichen Termine, Zustände und bekannten Boards werden
im vorhandenen PostgreSQL-Snapshot `team-match-watch` gespeichert. Keine neue
Tabelle und keine Zugangsdaten sind enthalten. Beim Wiederherstellen werden
Boarddaten als letzter bekannter Stand markiert und keine alten Feiern ausgelöst.
Ticker, Saison-API, Live-SSE und damit Website/Web-App verwenden denselben Stand.

Unter **Turniere & TV → Mannschaftsspiele überwachen** zeigt die geschützte
Verwaltung Mannschaft, überwachte Begegnung, Zustand und letzten erfolgreichen
Abruf. `/api/v1/darts/admin/match-watch` verlangt dieselbe Anmeldung wie die
übrige Verwaltung.

## Start-Push

`match_start` ist eine eigene auswählbare Ereignisart. Bestehende individuelle
Filter bleiben erhalten. Die erste bestätigte aktive Partie mit Teamstand 0:0,
Legstand 0:0 und höchstens sechs geworfenen Darts pro Seite ist ein frischer
Beginn. Hat der Wächter bereits vor dem Start auf diese Begegnung gewartet,
erkennt er auch verspätete erste Live-Daten während der ersten Einzel/Doppel.
Ein abgelaufener Countdown allein oder ein Einstieg mitten in eine bereits
laufende Begegnung ist kein bestätigter Beginn.
Vorbereitete Boards und veraltete Spielstände lösen nichts aus.

Die bestehende dauerhafte Ereignistabelle verhindert doppelte Zustellung über
mehrere Datenwege/Neustarts. Der Schlüssel gilt je Begegnung und Barver-Mannschaft,
auch bei einem Vereinsduell. Der Link öffnet die Begegnung in der Web-App.
Web Push und der vorhandene native Versand nutzen dieselbe Ereignisart.
Eine echte Handy-Zustellung muss beim nächsten Spiel auf dem Gerät geprüft werden.

## TV-Zusammenfassung und Bedienung

Der feste Abschlusszeitpunkt begrenzt die Zusammenfassung auf zehn Minuten;
Seitenaufruf und Datenaktualisierung starten sie nicht erneut. Gruppenbild,
bekannte Einzel-/Doppelergebnisse und verfügbare Bestleistungen erscheinen im
Mannschaftsfeld. Größere Ergebnislisten wechseln automatisch alle acht Sekunden.
Andere Mannschaften bleiben live sichtbar. Historische Ergebnisse werden beim
Öffnen nicht erneut als frischer Abschluss präsentiert.

Auf Touch-Geräten öffnet nur der kleine Menüknopf die Bedienung. „Fertig“,
Escape oder Tippen außerhalb schließen sie. Die Live-Boards bleiben weiterhin
einzeln vergrößerbar. Am PC bleibt die Bedienung per Mausbewegung/B erreichbar.

## Prüfung

- `python -m unittest discover -s tests -p 'test_darts*.py'`
- `node --test tests/test_darts_tv_studio.cjs`
- `node tests/test_darts_tv_studio_browser.cjs` mit Playwright
- Web-App: `npm test`, `npm run build:web`, `npm run build`, `npm run stage:web`

Live-Übergang und Zusammenfassung werden mit kontrollierten SSE-Daten geprüft.
Diese Prüfung ersetzt nicht die Beobachtung des nächsten echten 3K-Spielbeginns.
