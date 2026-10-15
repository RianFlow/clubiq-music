# Gemeinsame Spieltermine und abgeschlossener Pokal

Der vorhandene Server gleicht die laufenden und nächsten Liga-Spieltage alle fünf
Minuten separat ab. Zusätzlich berücksichtigt er den nächsten bekannten Termin
jeder Mannschaft, auch wenn die zugehörige Runde zeitlich außerhalb der aktuellen
Spieltage liegt. Pro Liga werden höchstens sechs bekannte Runden gelesen.
Dies ist keine Suche nach externen Turnierteilnahmen.

Der Abgleich verwendet dieselbe gezielte öffentliche 3K-Verbindung wie die
vorhandenen Funktionen. Er läuft mit Zeitlimits und zwei begrenzten parallelen
Ligaabfragen. Vollständige Saisonlisten, Tabellen, Spielerstatistiken und Pokal
sind keine Voraussetzung. Schlägt eine Liga fehl, kann die andere ihren neuen
Stand trotzdem speichern. Es werden ausschließlich normalisierte öffentliche
Spiel- und Adressangaben gespeichert.

Die Daten liegen in der vorhandenen Snapshot-Tabelle unter
`collector:fixtures:kl04` und `collector:fixtures:kk11`. Ein neuer Datenbankaufbau
ist nicht erforderlich. Die Web-Anwendung startet den ersten Abgleich drei
Sekunden nach ihrem Start; weitere Abgleiche benötigen keinen Besucher und keinen
eingeschalteten PC. Der bestehende Collector-Dienst bleibt unverändert.

Eine neuere Beobachtung ergänzt die bekannten Saison- und Tickerdaten, einschließlich
Datum, Heim-/Auswärtszuordnung und tatsächlicher Heimspielstätte. Mannschaftslisten,
Mannschaftsprofile, Startseite und Spielberichte nutzen denselben Stand. Auch bei
einem späteren Quellfehler bleibt die zuletzt bestätigte Verlegung erhalten.
Ein älterer Schreibvorgang darf die neueren Daten nicht ersetzen. Alte Tabellen
oder unvollständige Statistiken werden dadurch ausdrücklich nicht als aktuell
ausgegeben; die Anzeige unterscheidet aktuelle nächste Spieltermine vom älteren
übrigen Saisonstand.

Der Browser führt ebenfalls die neuesten Spielbeobachtungen aus Saison und Ticker
zusammen. Beim Wechsel des Heimteams wird dessen alter Spielort nicht übernommen.
Die direkte 3K-Ausweichverbindung übernimmt öffentlich vorhandene Adressen bereits
aus dem Spieltag. Der manuelle Hinweistext bleibt unabhängig von diesen Daten.

Nach bestätigtem Ausscheiden aller vier Mannschaften steht „Pokal-Ergebnisse“
unter „Mehr“. Ein älterer Datenstand holt den Reiter nicht zurück in die Hauptleiste.
Ein neu erkanntes offenes Pokalspiel kann den Reiter wieder aktivieren. Das Archiv
und gespeicherte Direktlinks bleiben auch nach dem Ausscheiden zugänglich.

In der Verwaltung erscheinen gespeicherte Spielerprofile sofort, während der
3K-Kader separat ergänzt wird. Späte Kaderantworten überschreiben keine inzwischen
bearbeiteten Formulare. Leseabfragen haben Zeitlimits, und ein verspäteter Bildfehler
kann nicht die Vorschau eines inzwischen gewählten anderen Spielers entfernen.
