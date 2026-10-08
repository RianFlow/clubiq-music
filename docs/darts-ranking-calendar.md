# DBD-Termine vor der ersten Wertung

Die 3K-Gesamtwertung liefert nur Runden mit Wertungsdaten. Der öffentliche Serienkalender liefert zusätzlich die noch nicht ausgetragenen Runden derselben Serie. `darts_ranking._load()` liest beide Quellen; der automatische Datenhelfer übernimmt diese vollständige Antwort alle zehn Minuten.

Verwendet werden ausschließlich Verein 1931 und Serie 1282 aus Datenbank 5. Der Kalender wird unter `/frontend/tournamentseries/1931?tournamentSeriesId=1282` geladen. Fehlt dort `eventList`, wird der vom offiziellen 3K-Webclient verwendete Abruf `/frontend/tournamentseries/1282/eventlist` genutzt. Eine fehlende oder ungültige Kalenderantwort kann keinen vollständigen gespeicherten Stand ersetzen.

`events` enthält alle veröffentlichten Serienrunden und deren bestätigte Portal-Links. `rated` kennzeichnet, welche Runden bereits in der Gesamtwertung stehen. Die offiziellen Punkte, Platzierungen und Teilnahmen werden dabei unverändert übernommen. Deshalb erscheint die Runde 32680 vom 23. Oktober 2026 auch vor ihrem ersten Ergebnis in der Rangliste und Turnierauswahl.

`static/darts-ranking-plans.json` enthält vom Verein genannte, ausdrücklich vorläufige Termine. Aktuell ist der 22. November 2026 in Barver vorgesehen. Diese Einträge werden als `plannedEvents` ohne Event-ID, Uhrzeit oder 3K-Link geliefert; sie erscheinen weder in der Punkteauswahl noch als gültiges Turnier. Ein Plan verschwindet automatisch nach seinem Datum oder sobald ein offizieller Serienkalender-Eintrag für denselben Tag und Ort vorhanden ist. Maßgeblich ist jeweils das deutsche Ortsdatum.
