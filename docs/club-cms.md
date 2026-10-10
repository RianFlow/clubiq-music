# Vereins-CMS – erste Version

Die Verwaltung unter `/cms` ist die gemeinsame Basis für mehrere Vereine.
Barver wird beim ersten Start einmalig übernommen; bestehende Angaben werden
bei späteren Updates nicht überschrieben. Weitere Vereine beginnen unveröffentlicht.

## Bedienung

1. Mit dem vorhandenen Darts-Verwaltungszugang anmelden.
2. Den Verein auswählen oder als Administration einen neuen Verein anlegen.
3. Unter **Vereinsseite** Name, Leitsatz, Beschreibung, Kontakt, Farbe und Logo pflegen.
4. Unter **Bilder & Logos** JPEG-, PNG- oder WebP-Bilder hochladen. Der Browser
   verkleinert sie auf maximal 1600 Pixel; der Server akzeptiert maximal 3 MB.
5. Einen **Beitrag** schreiben, die Vorschau ansehen und den Entwurf speichern.
6. Sofort veröffentlichen oder Beginn und optionales Ende festlegen.

Eine spätere Bearbeitung ändert zunächst nur den Entwurf. Die öffentliche Fassung
bleibt bis zum erneuten Veröffentlichen erhalten. Der Änderungsverlauf kann eine
ältere Fassung als neuen Entwurf wiederherstellen. Bei parallelen Änderungen
verhindert die Versionsprüfung das Überschreiben. Ungespeicherter Text bleibt bei
einem Konflikt im Formular; beim Verlassen wird nachgefragt.

Öffentliche Vereinsseiten liegen unter `/vereine/<adresse>`, Beiträge unter
`/vereine/<adresse>/beitraege/<id>`. Die Vereinsadresse ist nach dem Anlegen fest.
Barver-Beiträge erscheinen zusätzlich auf der bisherigen Startseite. Ohne
veröffentlichte Beiträge bleibt dieser Bereich verborgen, ebenso im TV-Modus.

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
Verwaltungsantworten und öffentlich zeitabhängige Inhalte verwenden `no-store`.
Inhalte werden als Text dargestellt, nicht als ausführbares HTML.

`CMS_TEST_POSTGRES=1 python -m unittest discover -s tests -p test_cms_postgres.py`
prüft echte HTTP-Anfragen und PostgreSQL in einem temporären Schema, einschließlich
Zugangstrennung, Veröffentlichung, Ablauf, privaten Bildern und Versionskonflikten.
`tests/test_cms_browser.cjs` prüft die Bedienung am PC und bei 320/390 Pixeln.

## Umfang dieser Version

Die allgemeine Version enthält Vereinsseiten, Beiträge, Medien, Vorschau,
Veröffentlichungszeiträume, Änderungsverlauf und getrennte Redakteurszugänge.
Die bestehende 3K-Anbindung mit Spielerprofilen, Sponsoren, Turnieren und Live-Darts
arbeitet weiterhin für Barver. Die Zuordnung eigener 3K-Vereine, Mannschaften und
Wettbewerbe für zusätzliche Vereine sowie individuelle Domains und ein freier
Seitenbaukasten sind weitere Ausbauschritte.
