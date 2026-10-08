# Automatischer Datenhelfer für Barver Darts

## Zweck und Betrieb

Der Helfer läuft als eigener Container auf dem Server. Sein Zeitplan benötigt weder einen geöffneten Browser noch einen Besucher der Website oder einen eingeschalteten Vereins-PC. Er verwendet die vorhandenen Parser für öffentliche 3K-Daten und speichert ausschließlich aufbereitete Daten für die Vereinswebsite.

| Daten | Normaler Abstand | Während eines erkannten laufenden Spiels |
| --- | --- | --- |
| Saisonspielplan und Mannschaftskader | 5 Minuten | 5 Minuten |
| KL 04 und KK 11: aktueller Spieltag und Tabelle | 5 Minuten | 1 Minute |
| Ergebnisübersicht | 5 Minuten | 1 Minute |
| Trainingsliste | 5 Minuten | 5 Minuten |
| Ausgewähltes Training | 5 Minuten | 1 Minute |
| DBD-Rangliste | 10 Minuten | 10 Minuten |
| Saisonstatistiken der Spieler | 15 Minuten | 15 Minuten |

Ein neu beginnendes Spiel wird beim nächsten normalen Abruf erkannt. Ausfälle führen zu begrenzten Wiederholungen nach 30, 60, 120 und anschließend 300 Sekunden. Ein Fehler in einem Bereich stoppt die anderen Abrufe nicht. Beliebige ausgewählte historische Spieltage und Turniere werden weiterhin über ihre bisherigen Ladewege abgerufen; sie gehören nicht zum Zeitplan des Helfers.

## Schutz der gespeicherten Daten

Nur vollständige, frisch bestätigte Antworten werden übernommen. Veraltete Ausweichdaten, falsche Ereignisse und fehlgeschlagene Abrufe überschreiben keinen erfolgreichen Stand. Der echte Zeitpunkt des Datenabrufs bleibt erhalten. Eine ältere parallel eintreffende Antwort kann die gespeicherten Daten nicht zurücksetzen.

Der Helfer schreibt in die vorhandene Tabelle `darts_feed_snapshots`, mit dem getrennten Schlüsselpräfix `collector:`. Seine eingebundenen Parser dürfen keine normalen Website-Snapshots nebenbei schreiben. Im Prüfbetrieb werden überhaupt keine Datenbankdaten geändert.

Die vorhandene Vereins-API liest diese Daten erst nach ausdrücklicher Aktivierung über `DARTS_COLLECTOR_READ_ENABLED=1`. Neue Daten werden dann ohne Neustart der Website sichtbar. Ist der Helfer zu lange ohne erfolgreichen Abruf, liefert die API den letzten Stand mit `stale: true` und unverändertem Datum. Aktive Spiele gelten nach zwei Minuten ohne Bestätigung als veraltet. Für normale Bereiche gelten das geplante Abrufintervall plus eine Minute. Trainingslinks und die Kennzeichnung veralteter Spielerwerte bleiben erhalten.

Die Aktivierung ist standardmäßig ausgeschaltet. Ohne Aktivierung bleiben die bisherigen Ladewege wirksam.

## Serverpaket und Kontrolle

`Dockerfile.darts-collector` baut ein separates Image mit den benötigten Bibliotheken. Der Container läuft ohne Administratorrechte, ohne eingehenden Netzwerkport und ohne Zugriff auf Firebase-, VAPID- oder Website-Admin-Schlüssel. Im Schreibbetrieb benötigt er ausschließlich die Datenbankverbindung. Der dauerhafte Prüfstatus liegt auf einem eigenen Volume.

Die ergänzende Datei `docker-compose.darts-collector.yml` wird nur mit dem Profil `darts-collector` gestartet. Sie ist kein Bestandteil eines normalen Website-Starts. Für den späteren Schreibbetrieb muss zuerst die bestehende Datenbank mit `darts_feed_snapshots` verfügbar sein.

Im Status stehen pro Datenbereich der letzte Versuch, der letzte Erfolg, das tatsächliche Datendatum, Fehlerart und nächste Prüfung. `allSourcesFresh` bewertet die Quelldaten. Die Container-Gesundheitsprüfung bewertet nur, ob der Prozess seinen Prüfstatus weiterhin aktualisiert. Ein laufender Prozess bedeutet daher nicht automatisch, dass 3K erreichbar ist.

Ein einzelner sicherer Quellentest ist möglich mit:

```text
python darts_collector.py --once --dry-run --only center-kl04 --status-file /tmp/collector-check.json
```

`--dry-run` schreibt keine Datenbankdaten. Ohne `--once` läuft der Zeitplan dauerhaft. Ein einmaliger Lauf beendet sich mit Code 0 bei vollständig bestätigten Daten und Code 2 bei fehlenden oder unvollständigen Quelldaten.

### Optionaler anderer Serverausgang

Der Helfer kann seine HTTPS-Abrufe über einen festen Proxy ausführen. Dafür wird auf dem Server `DARTS_COLLECTOR_HTTPS_PROXY` in der nicht versionierten Umgebung hinterlegt. Die zusätzliche Compose-Datei reicht diesen Wert ausschließlich an den Helfer weiter; die Website und die Datenbankverbindung erhalten ihn nicht. Ohne diesen Wert bleiben direkte Abrufe eingestellt. Es wurde noch kein Proxy bereitgestellt oder aktiviert.

Der Proxy benötigt eine echte erreichbare Ausgangsadresse und muss die HTTPS-Verbindung zur Originalquelle unterstützen. Die normale Prüfung des 3K-Zertifikats bleibt aktiv. Ein Proxy darf nicht mit einer frei erfundenen Absender-IP verwechselt werden: Die Antworten müssen den tatsächlichen Verbindungspartner erreichen. Vor einer Umschaltung ist derselbe vollständige serverseitige Prüflauf erforderlich. Proxy-Zugangsdaten gehören ausschließlich in die geschützte Serverumgebung und dürfen nicht in Git oder Diagnoseausgaben erscheinen.

Ein solcher Ausgang benötigt keinen Vereins-PC. Ob er die aktuelle Störung behebt, hängt von ihrer noch ungeklärten Ursache ab; eine bestätigte Sperre der Vereinsserver-IP liegt bislang nicht vor.

Technische Grundlage: [Requests: Proxy-Unterstützung](https://requests.readthedocs.io/en/latest/user/advanced/#proxies).

## Prüfstand vom 8. Oktober 2026

Der Helfer wurde als eigenes Image auf dem vorhandenen Server gebaut. Container-Konfiguration, Speicherung in einer getrennten Wegwerfdatenbank, Schutz vor älteren Antworten und das nicht privilegierte Status-Volume wurden erfolgreich geprüft. Die Live-Website wurde dabei nicht neu gebaut oder veröffentlicht.

Der separate Container `clubiq-darts-collector-check` läuft auf dem Server mit automatischem Wiederanlauf und `--dry-run`. Er besitzt keine Datenbankzugangsdaten. Er kann selbstständig weitere Quellentests durchführen, aber verändert keine Website-Daten. Image: `clubiq-darts-collector:test-20261008`; Status: `/state/status.json`.

Die Quellen sind aktuell auf dem Server nicht vollständig erreichbar:

| Ziel | IPv4-Adresse | Serververbindung zu Port 443 |
| --- | --- | --- |
| `backend-ddv.3k-darts.com` | `148.251.140.149` | Zeitüberschreitung |
| `backend4.3k-darts.com` | `148.251.140.149` | Zeitüberschreitung |
| `portal.3k-darts.com` | `128.140.28.184` | Erfolgreich |
| `scorer.3k-darts.com` | `128.140.28.184` | Erfolgreich |
| `live.3k-darts.com` | `85.214.192.144` | Erfolgreich |

Ein getrennt gestarteter Server-Browser erreicht ebenfalls das Portal, aber nicht die beiden Datenserver. Die geprüften ausgehenden Firewall-Regeln enthalten keine Sperre. Die genaue Ursache der fehlenden Verbindung ist offen; eine Filterung oder Störung außerhalb des Servers ist damit noch nicht bewiesen. Ein anderer Zeitplan, eine eigene Vereins-API oder zusätzliche Browserautomation beheben diese Verbindungsstörung nicht.

Ein einmaliger Vergleichstest von einem erreichbaren anderen Anschluss konnte alle acht vorgesehenen Datenbereiche erfolgreich prüfen. Dieser Vergleich ist **kein Bestandteil des dauerhaften Betriebs**. Es ist keine PC-Weiterleitung oder PC-Automation eingerichtet.

Vor dem Schreibbetrieb und der Website-Aktivierung muss ein vollständiger serverseitiger Quellentest erfolgreich sein. Zusätzlich sind die veröffentlichte Git-Version und parallele App-Arbeiten erneut abzugleichen. Der Website-Leseschalter bleibt bis dahin ausgeschaltet.

## Grenzen der 3K-Anbindung

3K dokumentiert keine öffentliche API für Ergebnisse und Tabellen. Die vorhandenen öffentlichen Webseitenzugänge sind daher keine zugesicherte Schnittstelle und können sich ändern. Die offiziell angebotene Einbindung erfolgt über feste Portal-Links in einem eingebetteten Fenster. Für einen dauerhaft unterstützten eigenen Datenzugang wäre eine Abstimmung mit 3K sinnvoll.

Die verlinkte Android-App bietet Turniere, Spielerprofile und Live-Ticker. Daraus lässt sich keine freigegebene Fremdanbieter-API ableiten. Laut 3K ist ihr neuer Scorer eine WebApp, die sowohl im Browser als auch innerhalb der App geöffnet wird. Ob andere Bereiche der mobilen App zusätzliche Datenserver verwenden, ist nicht verifiziert.

Quellen:

- [3K: Schnittstelle und Einbindung in Webseiten](https://2k-dartsoftware.freshdesk.com/support/solutions/articles/103000362922-schnittstelle-api-einbindung-in-webseiten)
- [3K Darts bei Google Play](https://play.google.com/store/apps/details?id=de.twok.dartsoftware&hl=de)
- [3K: Erste Schritte mit dem Scorer](https://2k-dartsoftware.freshdesk.com/support/solutions/articles/103000411192-3k-darts-scorer-erste-schritte)
