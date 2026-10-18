# Website und installierte Web-App

`/app/` und `/app/index.html` liefern dieselbe `darts.html` wie `/darts`.
Inhalte, Sportdaten, öffentliche Verwaltungseinstellungen, News, Mannschaften,
Tabellen, Profile und TV-Modus verwenden damit eine gemeinsame Implementierung.
Die vorhandenen responsiven Website-Stile passen die Anzeige an das Gerät an.

`darts_web_app.py` hält Navigation, Training und Turniere unter `/app/`.
Der installierte App-Eintrag, Manifest-ID `/app/`, Scope, Icons und vorhandene
Push-Registrierung bleiben erhalten. `/app/live` nutzt weiter dieselbe TV-Ansicht.
Match-Push öffnet `?match=ID`; Training-Push öffnet `/app/training?event=ID`.

`static/darts-web-app.js` übernimmt beim ersten Aufruf alte App-Einstellungen
nur, wenn es noch keine entsprechende Website-Einstellung gibt. Gespeicherte
Abwahlen werden übernommen. Der alte Push-Verlauf wird zusammengeführt.
Die Umstellung fordert keine Push-Erlaubnis an und ändert keine Abonnements.
Training kann wie bisher ausdrücklich in den Meldungseinstellungen gewählt werden.

`/app/sw.js` liefert `static/darts-web-app-sw.js`. Der Worker ersetzt ausschließlich
alte App-Oberflächen-Caches, behält den Verlauf und registrierte Abonnements und
lädt die geöffnete alte Startseite einmal neu. TV-Ansichten werden nicht neu geladen.
HTML und öffentliche Assets verwenden zuerst das Netzwerk mit Offline-Rückfall.
API-Antworten werden nicht vom Worker zwischengespeichert.

Die native Capacitor-App und ihre gebauten Dateien bleiben eine getrennte
Oberfläche unter `mobile/`. `build:web` und die bisherigen Mobile-Tests prüfen
auch weiterhin diese kompakte Variante; sie ist nicht mehr die öffentliche
Startseite unter `/app/`. Beim Staging dürfen bestehende Icons nicht entfernt
werden. Die produktive Web-App-Oberfläche benötigt keinen separaten Mobile-Build.

## Zeitabhängiger Spielplan

`current_schedule` bewertet gespeicherte und frisch geladene Spielpläne bei
jedem Abruf erneut. Ein unbestätigter Ansatz wird nach acht Stunden als vorläufig
beendet geführt und nicht weiter als nächstes Spiel beworben. Das erfindet
weder Endstand noch Sieger. Aktive Live-Daten können diesen Status übersteuern.
Bestätigte Ergebnisse bleiben nach Ablauf der zehnminütigen TV-Zusammenfassung
bis zu 60 Tage im dauerhaften Wächter erhalten, auch wenn ein älterer Saisonstand
die Begegnung noch als bevorstehend führt.

## Prüfung

- `python -m unittest discover -s tests -p 'test_darts*.py'`
- `node tests/test_darts_web_app_browser.cjs`
- bestehende Startseiten-, Trainings- und TV-Browsertests
- `npm test --prefix mobile` und bisherige Mobile-Builds

Der neue Browsertest prüft die Migration eines alten Cache-Workers, Smartphone
und PC, unveränderte Push-Abos, Einstellungen, Verlauf, Vereinslogo, Mannschaften,
Spielbericht, Trainingslink und Rückweg aus dem TV-Modus. Simulierte lokale
Meldungen prüfen keine tatsächliche Zustellung auf einem Handy.
