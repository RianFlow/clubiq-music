# Automatische Erholung bei 3K-Ausfällen

Der Server speichert ausschließlich die bereits normalisierten öffentlichen
Ticker-, Saison- und Spieltagsdaten in `darts_feed_snapshots`. Der ursprüngliche
Zeitpunkt des Abrufs bleibt erhalten. Alte oder unvollständige Antworten
überschreiben keinen vollständigen Stand. Die Daten bleiben nach einem
Container-Neustart verfügbar; `bootstrap.py` ergänzt die Tabelle idempotent.

Bei Verbindungsfehlern, HTTP 403, 429 oder Serverfehlern pausiert der betroffene
3K-Host für 30, 60, 120 und höchstens 300 Sekunden. Während der Pause verwenden
Besucher und Hintergrundjobs den letzten gültigen Stand. Anschließend darf
zunächst ein Abruf die Verbindung prüfen. Ein Erfolg stellt den normalen
Abruf automatisch wieder her. Ein leeres Ergebnis nach Ausfall beider Ligen
gilt ausdrücklich nicht als erfolgreicher Saisonabgleich. Veraltete oder
unvollständige Saisonantworten beenden keine laufenden Live-Gruppen.

Erreicht der Server den 3K-Host nicht, prüft die Website selbst die öffentlichen
3K-Endpunkte über die vom Anbieter erlaubte CORS-Verbindung. Diese Alternative
lädt die beiden Vereinsligen, jeweils den letzten und nächsten Spieltag sowie
die öffentlichen Live-Punkte. Sie sendet keine Anmeldedaten und akzeptiert keine
beliebigen Zieladressen. Die CSP erlaubt ausschließlich die beiden benötigten
3K-Hosts zusätzlich zur eigenen Website. Abrufe teilen sich eine laufende
Anfrage, haben eine Gesamtfrist von 15 Sekunden und erfolgen höchstens alle
30 Sekunden. Die normale Serververbindung wird weiter geprüft.

Die Anzeige unterscheidet „Alternative 3K-Verbindung aktiv“, nicht erreichbare
Live-Punkte und den letzten bekannten Stand mit seinem Alter. Die Alternative
aktualisiert Liga-Ergebnisse und Live-Punkte; Saison, Einzelberichte, Rangliste,
Turniere und Push-Meldungen benötigen weiterhin ihre jeweilige Serverquelle.
Bei vollständigem Netzausfall bleiben gespeicherte Daten sichtbar, ohne einen
aktuellen Spielstand vorzutäuschen.

Tests decken Ausfall, begrenzte Wiederholung, nur einen Wiederverbindungsversuch,
Neustart, unvollständige Saisonantworten, PostgreSQL-Speicherung, öffentliche
Feldfreigabe und den Wechsel zwischen Server und Browser-Verbindung ab.
