# Darts-Sportseite – Stand 27. September 2026

## Paket 4–6: lokal umgesetzt, Veröffentlichung separat prüfen

- Startseite: hervorgehobene Live-Begegnung (Lieblingsteam bevorzugt), alle
  vier Mannschaften, Heute/Demnächst/Letzte Ergebnisse. Mobil sind A–D als
  gleichwertiges 2×2-Raster sichtbar. Der TV-Modus behält alle Live-Begegnungen.
- Filter nach Team, Liga/Sonderwettbewerb und Datum. Der kompakte Überblick
  zeigt je Abschnitt maximal acht Spiele; der Saisonspielplan bleibt vollständig.
- Highlights-Rückblick aus den letzten 30 Tagen, ausdrücklich mit Datum.
  Die Zeit kommt vom zugehörigen 3K-Spiel, nicht vom exakten Dartwurf.
- „Mein Darts“ speichert pro Browser Teams, Spieler und Meldungsarten.
  Teams ODER Spieler, anschließend Einschränkung nach Meldungsart.
  Leere Mannschaftsauswahl erlaubt reine Spieler-Abos; leere Meldungsarten
  unterdrücken alle Meldungen. Gesamtergebnisse benötigen ein Team-Abo.
- Spielerabgleich verwendet vollständige 3K-Namen, auch Doppelpartner.
  Namensänderungen in 3K können ein erneutes Auswählen erfordern.
- Verlauf: maximal 100 tatsächlich im Browser-Service-Worker empfangene
  Meldungen, auch bei geschlossener Seite. Lokale Browserdaten löschen entfernt
  diesen Verlauf. Es gibt keinen rückwirkenden Zustellnachweis vor diesem Update.
- Ticker und Saison bleiben bei Störungen sichtbar, auch nach Neuladen.
  Wiederholungsversuche mit wachsendem Abstand, keine parallelen Tickerabrufe.
  Warnung ab drei Minuten altem Ticker-/Live-Datenstand.
- Push-Anzeige prüft Konfiguration, letzten erfolgreichen Datenabruf und
  gemeldete Zustellfehler. „Server bereit“ garantiert keine Anzeige auf einem
  ausgeschalteten Gerät oder bei blockierten Betriebssystem-Benachrichtigungen.
- Öffentliche Highlights enthalten keine Abonnementdaten oder Browser-Endpunkte.
- Peddy: Darts 95K von Aspinall, Nathan Aspinall, Lieblingsfinish D16,
  Einlaufsong Don't Stop Believin' – Journey. Gewicht nicht angegeben.

## Datenbank und Betrieb

`bootstrap.py` ergänzt idempotent `players`/`event_types` an den Abonnements
und `payload`/`occurred_at` am vorhandenen Ereignisarchiv. Bestehende Abos
behalten alle bisherigen Meldungsarten. Ereignis-IDs bleiben zur Deduplizierung
erhalten. Alte Archiveinträge erhalten beim nächsten normalen 3K-Abgleich
ihren Anzeigetext, lösen dadurch aber keine erneute Push-Meldung aus.

Wie bisher erfasst der automatische Push-Sammler die eingerichteten Ligen
kl04/kk11. Sonderveranstaltungen im Spielplan bedeuten nicht automatisch,
dass deren Würfe ebenfalls im Push-Sammler erfasst werden.

Tests: JS-Helfer, Push-Filter, Service-Worker-Verlauf und Browser mit lokalen
Testdaten (Mobil/Desktop, zwei Boards, Spielerabo, Filter, Netzausfall).
Produktive Push-Zustellung und Datenbankmigration müssen beim Rollout geprüft
werden. Keine Live-Datenbank oder laufende Raspberry-Dienste lokal verändert.

## Nächster Ausbau: geschützte Spieler-Verwaltung

Ein eigener angemeldeter Verwaltungsbereich für Vereinsverantwortliche:

1. Spieler anhand der vorhandenen 3K-ID auswählen; Name/Team bleiben aus 3K.
2. Foto hochladen und Vorschau für Spielerkarte/Profil anzeigen. Dateityp,
   Dateigröße und Bildabmessungen prüfen; Metadaten entfernen; WebP-Varianten.
3. Alias und Persönlich-Felder bearbeiten: Darts, Gewicht, Lieblingsspieler,
   Lieblingsfinish (z. B. D16 oder 121) samt optionalem Weg und Einlaufsong.
4. Entwurf/Vorschau, Veröffentlichung, Änderungsprotokoll und Rücknahme.
5. Persönliche Rollen statt gemeinsamem Passwort; vorhandene sichere
   Verwaltungsanmeldung prüfen und möglichst wiederverwenden. Kein öffentliches
   Uploadformular. Bilder und Einstellungen in die Sicherung aufnehmen.

Noch nicht implementiert: Administrations-Anmeldung, Upload-API und Bearbeitungsmaske.
