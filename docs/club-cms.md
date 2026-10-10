# Vereins-CMS und wiederverwendbare Darts-Spielseite

Die Verwaltung unter `/cms` ist die gemeinsame Basis für mehrere Vereine.
Barver wird beim ersten Start einmalig übernommen; bestehende Angaben werden
bei späteren Updates nicht überschrieben. Weitere Vereine beginnen unveröffentlicht.

## Bedienung

1. Mit dem vorhandenen Darts-Verwaltungszugang anmelden.
2. Den Verein auswählen oder als Administration einen neuen Verein anlegen.
3. Unter **Vereinsseite** Name, Leitsatz, Beschreibung, Kontakt, Farbe, Logo und Mannschaften pflegen.
4. Unter **Bilder & Logos** JPEG-, PNG- oder WebP-Bilder hochladen. Der Browser
   verkleinert sie auf maximal 1600 Pixel; der Server akzeptiert maximal 3 MB.
5. Einen **Beitrag** schreiben, Startseite oder einzelne Mannschaften auswählen,
   die Vorschau ansehen und den Entwurf speichern.
6. Sofort veröffentlichen oder Beginn und optionales Ende festlegen.

Eine spätere Bearbeitung ändert zunächst nur den Entwurf. Die öffentliche Fassung
bleibt bis zum erneuten Veröffentlichen erhalten. Der Änderungsverlauf kann eine
ältere Fassung als neuen Entwurf wiederherstellen. Bei parallelen Änderungen
verhindert die Versionsprüfung das Überschreiben. Ungespeicherter Text bleibt bei
einem Konflikt im Formular; beim Verlassen wird nachgefragt.

Öffentliche Vereinsseiten liegen unter `/vereine/<adresse>`, Beiträge unter
`/vereine/<adresse>/beitraege/<id>`. Die Vereinsadresse ist nach dem Anlegen fest.
Für die Startseite freigegebene Barver-Beiträge erscheinen zusätzlich auf der bisherigen Startseite.
Mannschaftsbeiträge erscheinen bei der ausgewählten Mannschaft, auch im bisherigen
Barver-Mannschaftsprofil. Eine Änderung der Zielbereiche wirkt erst beim erneuten
Veröffentlichen. Ohne
veröffentlichte Beiträge bleibt dieser Bereich verborgen, ebenso im TV-Modus.

## Darts-Seite für einen weiteren Verein einrichten

1. Vereinsangaben und Mannschaftsnamen speichern.
2. Unter **Darts-Seite** eine Liga hinzufügen und deren öffentlichen
   3K-Spielplan-Link eintragen, zum Beispiel
   `https://portal.3k-darts.com/frontend/events/10/event/123/phase/456`.
3. **Verbindung prüfen** lädt die offiziellen Mannschaften der Liga. Für jede eigene
   Mannschaft den passenden Eintrag wählen; jede eigene Mannschaft gehört in
   dieser Version zu genau einer Liga. Es können bis zu acht Ligen verbunden werden.
4. Die Administration aktiviert die Darts-Spielseite. Die Vereinsseite muss
   ebenfalls öffentlich freigegeben sein.
5. Einrichtung speichern und **Spielseite ansehen** öffnen.

Die öffentliche Spielseite liegt unter `/vereine/<adresse>/darts`. Sie enthält
Übersicht, nächste Spiele, Ergebnisse, Live-Boards, Spielberichte, offizielle
Tabellen, Kader und Mannschaftsbeiträge. LIVE-Markierungen in der Tabelle öffnen
den zugehörigen Spielbericht. Auf dem Handy lassen sich einzelne Boards vergrößern
und wieder verkleinern; der TV-Modus stellt die Live-Werte größer dar. Vereinsname,
Logo, Mannschaftsnamen und Farben kommen aus dem ausgewählten CMS-Verein.

Die Einrichtung unterstützt öffentliche Liga-Spielpläne aus der angebundenen
3K-Datenbank (`events/10`). Andere 3K-Datenbanken, Turniere und Trainings sind
für zusätzliche Vereine noch nicht Teil dieser Einrichtung. Barvers bereits
bestehende Turnier-, Trainings- und Push-Funktionen bleiben separat erhalten.
Die bisherige Barver-Startseite wird durch diese neue Vorlage nicht ersetzt;
CMS-Ligaänderungen betreffen die neue Vereins-Spielseite.

## Getrennte Vereine und Zugänge

- Die Administration verwaltet alle Vereine und legt Redakteure an.
- Ein Redakteur kann ausschließlich Beiträge, Bilder und Angaben seines Vereins
  bearbeiten. Er kann keine Vereine oder Zugänge anlegen und keine Vereinsseite
  freigeben. Die Veröffentlichung von Beiträgen seines Vereins ist erlaubt.
- Die öffentliche Freigabe der Vereinsseite liegt bei der Administration.
- Bilder sind nur öffentlich abrufbar, wenn die öffentliche Vereinsseite sie als
  Logo oder ein aktuell veröffentlichter Beitrag sie verwendet. Entwürfe und
  Bilder anderer Vereine sind über öffentliche Endpunkte nicht abrufbar.
- Die Darts-Verwaltung bleibt für Barver mit dem bestehenden Zugang verfügbar.
  Neue Redakteurszugänge erhalten dadurch keinen Zugriff auf ihre Funktionen.

Neue Passwörter werden mit zufälligem Salt und PBKDF2-SHA256 gespeichert.
Anmeldungen verwenden kurzlebige, serverseitige Sitzungen mit HttpOnly- und
SameSite-Cookie. Das CMS speichert kein Passwort im Browser. Passwortänderungen,
Deaktivierung und Abmeldung beenden die betroffenen Sitzungen. Änderungen am
bestehenden Verwaltungszugang machen dessen CMS-Sitzungen ungültig.

## Serverbetrieb und Prüfung

Die zusätzlichen `cms_*`-Tabellen werden durch die idempotente bestehende
Servermigration angelegt und sind Teil der Datenbanksicherung. Zeitgesteuerte
Veröffentlichungen werden beim öffentlichen Abruf anhand der Serverzeit geprüft;
sie benötigen weder einen laufenden Nutzer-PC noch einen zusätzlichen Zeitgeber.
Ein serverseitiger Datenhelfer prüft neue Vereinskonfigurationen jede Minute und
holt Spielplan, Tabelle und Kader ungefähr alle fünf Minuten. Live-Daten werden
alle 15 Sekunden geprüft. Browser lesen ausschließlich die vereinseigenen
Server-Endpunkte. Bei Fehlern wird nach einer Minute erneut versucht; ein
vollständiger Stand bleibt in PostgreSQL erhalten und übersteht Neustarts.
Ein veränderter Liga-Link erhält erst nach erfolgreichem Abruf einen neuen Stand;
alte Daten einer anderen Konfiguration werden nicht als aktuelle ausgegeben.
Spielorte der nächsten Begegnungen werden aus den öffentlichen Heimvereinsangaben
ergänzt. Barver nutzt bei unveränderter Einrichtung seinen vorhandenen Datenhelfer.
Verwaltungsantworten und öffentlich zeitabhängige Inhalte verwenden `no-store`.
Inhalte werden als Text dargestellt, nicht als ausführbares HTML.

`CMS_TEST_POSTGRES=1 python -m unittest discover -s tests -p test_cms_postgres.py`
prüft echte HTTP-Anfragen und PostgreSQL in einem temporären Schema, einschließlich
Zugangstrennung, Veröffentlichung, Ablauf, privaten Bildern und Versionskonflikten.
`tests/test_cms_browser.cjs` prüft CMS-Einrichtung und Bedienung am PC und bei
320/390 Pixeln. `tests/test_club_darts_browser.cjs` prüft die allgemeine Spielseite,
Live-Werte, Tabellen, Spielberichte, TV-Modus und letzte verfügbare Daten.

## Umfang dieser Version

Die allgemeine Version enthält eine konfigurierbare Liga-Spielseite, Vereinsseiten,
Mannschaftsbeiträge, Medien, Vorschau, Veröffentlichungszeiträume, Änderungsverlauf
und getrennte Redakteurszugänge. Die bestehende Barver-Seite mit Spielerprofilen,
Sponsoren, Turnieren und Live-Push bleibt erreichbar. Individuelle Domains, frei
zusammenstellbare Seiten, Trainings-/Turnierquellen und Push für weitere Vereine
sind weitere Ausbauschritte.
