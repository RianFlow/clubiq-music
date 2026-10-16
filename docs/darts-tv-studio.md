# TV-Ansicht der Mannschaftsspiele

Die Ansicht startet auf der Website über **TV-Modus → Mannschaftsspiele**.
Auf Bildschirmen ab 651 Pixel Breite verwendet sie das TV-Studio. Auf dem Handy
bleibt die kompakte Ansicht mit einzeln vergrößerbaren Boards erhalten.

- Eine Mannschaft: zwei große Boards nebeneinander.
- Zwei Mannschaften: Mannschaftsfelder nebeneinander, je zwei Boards darunter.
- Drei oder vier Mannschaften: 2×2-Raster mit bis zu acht gleichzeitig sichtbaren
  Partien. Der Gesamtstand bleibt für jede Begegnung sichtbar.
- Ohne aktives Board zeigt das Mannschaftsfeld das zugehörige Gruppenbild.
  Vorhanden sind A, B und D; ohne Gruppenbild erscheint das Vereinslogo.
  Fehlende Daten oder Verbindungsprobleme erhalten eine eigene Statusanzeige.
- Leggewinne erscheinen sechs Sekunden mit den vorhandenen Spielerfotos.
  Einzel-, Doppel- und Mannschaftsergebnisse erscheinen acht Sekunden.
  Siege ganzer Partien erhalten zusätzlich eine kurze Animation; Niederlagen
  bleiben kleine Hinweise. Andere Mannschaftsfelder bleiben sichtbar.
- Ein gerade beendetes Mannschaftsspiel bleibt bis zu 90 Sekunden als Ergebnis
  sichtbar. Bereits beendete Spiele werden beim Öffnen nicht erneut gefeiert.
- Bedienung: Maus bewegen, **B** oder **Tab**. Mannschaftsauswahl,
  Kaderpräsentation, Hell/Dunkel und TV-Modus beenden sind dort erreichbar.
  Spielerprofile laufen weiterhin jeweils acht Sekunden.

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
