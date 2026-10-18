# TV-Ansicht der Mannschaftsspiele

Die Ansicht startet auf der Website über **TV-Modus → Mannschaftsspiele**.
Auf Bildschirmen ab 651 Pixel Breite verwendet sie das TV-Studio. Auf dem Handy
bleibt die kompakte Ansicht mit einzeln vergrößerbaren Boards erhalten.

- Eine Mannschaft: zwei große Boards nebeneinander.
- Zwei Mannschaften: Mannschaftsfelder nebeneinander, je zwei Boards darunter.
- Drei oder vier Mannschaften: 2×2-Raster mit bis zu acht gleichzeitig sichtbaren
  Partien. Der Gesamtstand bleibt für jede Begegnung sichtbar.
- Vor dem geplanten Start zeigt die TV-Ansicht den Countdown. Ab der Startzeit wird daraus eine Mannschaftskarte mit der Begegnung und dem Hinweis „Warten auf Live-Spielstände“ – auch wenn 3K noch keine Live-Werte meldet. In diesem Zustand werden keine fiktiven Scores oder Boards angezeigt; die Anzeige bleibt höchstens sechs Stunden nach dem angesetzten Beginn erhalten.
- Bei ausbleibenden Live-Signalen wird rund um den Start (15 Minuten vorher bis sechs Stunden danach) zusätzlich die öffentliche 3K-Quelle direkt geprüft, auch wenn der Spielplan bereits frisch ist. Separat bekannte Pokaltermine bleiben bei einem erfolgreichen Fallback erhalten.
- Ohne aktives Board zeigt das Mannschaftsfeld das zugehörige Gruppenbild.
  Vorhanden sind A, B und D; ohne Gruppenbild erscheint das Vereinslogo.
  Fehlende Daten oder Verbindungsprobleme erhalten eine eigene Statusanzeige.
- Leggewinne erscheinen sechs Sekunden mit den vorhandenen Spielerfotos.
  Einzel-, Doppel- und Mannschaftsergebnisse erscheinen acht Sekunden.
  Siege ganzer Partien erhalten zusätzlich eine kurze Animation; Niederlagen
  bleiben kleine Hinweise. Andere Mannschaftsfelder bleiben sichtbar.
- Ein gerade beendetes Mannschaftsspiel bleibt zehn Minuten als Zusammenfassung
  mit Gruppenbild, bekannten Einzelergebnissen und Bestleistungen sichtbar.
  Der Abschlusszeitpunkt bleibt bei Aktualisierung und Neustart erhalten.
  Bereits beendete Spiele werden beim Öffnen nicht erneut gefeiert.
- Bedienung: Maus bewegen, **B** oder **Tab**. Mannschaftsauswahl,
  Kaderpräsentation, Hell/Dunkel und TV-Modus beenden sind dort erreichbar.
  Spielerprofile laufen weiterhin jeweils acht Sekunden.
- Die Mannschaftsauswahl begrenzt die dargestellten Spiele. Bestätigte Ereignisse
  anderer Barver-Mannschaften werden trotzdem eingeblendet, bei fehlendem
  Mannschaftsfeld als übergreifende Grafik. Spielerbilder, Doppelpaarungen und
  Mannschaftsfotos bleiben dabei erhalten. Mehrere Siege laufen nacheinander;
  die gewählte Mannschaft und der laufende Countdown ändern sich dadurch nicht.
- Am Handy öffnet ausschließlich ein kleiner Menüknopf die Auswahl. „Fertig“
  oder Tippen außerhalb schließen sie; Berührungen der Spiele öffnen kein Menü.

Die dauerhafte serverseitige Spielüberwachung und den Start-Push beschreibt
[Mannschaftsspiele überwachen](darts-match-watch.md).

`static/darts-tv-studio.js` erhält ausschließlich die bereits geladenen Daten
aus `static/darts.js`; es öffnet keine zusätzliche 3K- oder API-Verbindung.
Die vorhandene Ereigniswarteschlange und Dublettenerkennung in
`static/darts-broadcast.js` steuern auch die TV-Einblendungen. Reine
Spielstandsaktualisierungen starten eine laufende Siegeranimation nicht neu.

Restpunkte, Darts, geworfene Punkte und AVG im Studio beziehen sich auf das
aktuelle Leg. Fehlende Zahlen erscheinen als Strich. Der Spielbericht behält
seine bisherige Kennzeichnung des AVG für die gesamte Partie.

Prüfung: `node tests/test_darts_tv_studio_browser.cjs` mit installiertem
Playwright, optional `PLAYWRIGHT_CHANNEL=msedge`. Der Browsercheck verwendet
lokale SSE-Testdaten und prüft acht Boards, passende Pausenbilder,
Siegerfotos, Datenaktualisierungen während einer Animation, Endstände,
Mannschaftsauswahl und den Wechsel zwischen TV und Handy.
