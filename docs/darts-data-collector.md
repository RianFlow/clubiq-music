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

Nur vollständige, frisch bestätigte Antworten werden übernommen. Veraltete Ausweichdaten, falsche Ereignisse und fehlgeschlagene Abrufe überschreiben keinen erfolgreichen Stand. Tabellen müssen ihre Platzierungen aus 3K enthalten; reine Mannschaftslisten gelten nicht als frische Tabelle. Fehlende Saisonrunden, veraltete einzelne Spielerstatistiken und nicht verfügbare Trainingsdetails werden ebenfalls abgewiesen. Der echte Zeitpunkt des Datenabrufs bleibt erhalten. Eine ältere parallel eintreffende Antwort kann die gespeicherten Daten nicht zurücksetzen.

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

### Eigener Serverausgang für 3K

Die zusätzliche Compose-Datei richtet den getrennten Dienst `darts-egress` ein. Er verwendet einen kleinen Userspace-WireGuard-Client und stellt einen HTTP-CONNECT-Proxy ausschließlich im eigenen Docker-Netzwerk bereit. Er braucht keinen Vereins-PC, kein TUN-Gerät und keine Änderung der Host-Routen. Private Registrierung und Profil liegen nur im geschützten Server-Volume. Versionspins, Gesundheitsprüfung und Betrieb sind in [darts-egress.md](darts-egress.md) beschrieben.

Website und Helfer verwenden `DARTS_3K_HTTPS_PROXY`, standardmäßig `http://darts-egress:40001`. Die Einstellung gilt ausschließlich für `backend-ddv.3k-darts.com`, `backend4.3k-darts.com` und `live.3k-darts.com`. HTTPS-Abrufe und Live-WebSockets zu diesen Hosts nutzen den neuen Ausgang; Musik, Firebase, Datenbank und sonstige Dienste erhalten keine globalen Proxy-Einstellungen. Auch zusätzliche Spielberichte, ältere Spieltage und frei ausgewählte Trainings oder freigegebene Turniere nutzen diesen Transport.

Der Proxy benötigt eine echte erreichbare Ausgangsadresse und muss die HTTPS-Verbindung zur Originalquelle unterstützen. Die normale Prüfung des 3K-Zertifikats bleibt aktiv. Ein Proxy darf nicht mit einer frei erfundenen Absender-IP verwechselt werden: Die Antworten müssen den tatsächlichen Verbindungspartner erreichen. Vor einer Umschaltung ist derselbe vollständige serverseitige Prüflauf erforderlich. Proxy-Zugangsdaten gehören ausschließlich in die geschützte Serverumgebung und dürfen nicht in Git oder Diagnoseausgaben erscheinen.

Ein solcher Ausgang benötigt keinen Vereins-PC. Der Vergleichstest vom 8. Oktober bestätigt, dass ein anderer tatsächlicher Serverausgang die aktuelle Verbindungsstörung im geprüften Zeitraum behebt. Ob die Ursache eine IP-Filterung oder eine Störung des Verbindungswegs ist, bleibt offen.

Technische Grundlage: [Requests: Proxy-Unterstützung](https://requests.readthedocs.io/en/latest/user/advanced/#proxies).

## Prüfstand vom 8. Oktober 2026

Der Helfer wurde als eigenes Image auf dem vorhandenen Server gebaut. Container-Konfiguration, Speicherung in einer getrennten Wegwerfdatenbank, Schutz vor älteren Antworten und das nicht privilegierte Status-Volume wurden erfolgreich geprüft. Die Live-Website wurde dabei nicht neu gebaut oder veröffentlicht.

Der separate Container `clubiq-darts-collector-check` läuft auf dem Server mit automatischem Wiederanlauf und `--dry-run`. Er besitzt keine Datenbankzugangsdaten. Er kann selbstständig weitere Quellentests durchführen, aber verändert keine Website-Daten. Image: `clubiq-darts-collector:test-20261008`; Status: `/state/status.json`.

Über den ursprünglichen direkten Serverausgang sind die Quellen nicht vollständig erreichbar:

| Ziel | IPv4-Adresse | Serververbindung zu Port 443 |
| --- | --- | --- |
| `backend-ddv.3k-darts.com` | `148.251.140.149` | Zeitüberschreitung |
| `backend4.3k-darts.com` | `148.251.140.149` | Zeitüberschreitung |
| `portal.3k-darts.com` | `128.140.28.184` | Erfolgreich |
| `scorer.3k-darts.com` | `128.140.28.184` | Erfolgreich |
| `live.3k-darts.com` | `85.214.192.144` | Erfolgreich |

Ein getrennt gestarteter Server-Browser erreicht ebenfalls das Portal, aber nicht die beiden Datenserver. Die geprüften ausgehenden Firewall-Regeln enthalten keine Sperre. Die genaue Ursache der fehlenden Verbindung ist offen; eine Filterung oder Störung außerhalb des Servers ist damit noch nicht bewiesen. Ein anderer Zeitplan, eine eigene Vereins-API oder zusätzliche Browserautomation beheben diese Verbindungsstörung nicht.

Ein anschließender Vergleichstest lief vollständig auf dem Vereinsserver: Ein eigener kurzlebiger Container stellte einen Cloudflare-WARP-Ausgang im lokalen Proxy-Modus bereit. Nur der separate Prüfprozess nutzte diesen Ausgang. Host-Routen, Website-Container und Datenbank blieben unverändert. Die TLS-Zertifikatsprüfung blieb bei allen Anfragen eingeschaltet.

Am 8. Oktober 2026 um 20:36 Uhr und nochmals um 20:46 Uhr (Europe/Berlin) bestanden alle acht geplanten Datenbereiche. Der erste Durchlauf enthielt 134 HTTPS-Anfragen, der zweite 181 einschließlich vier zusätzlicher Detailprüfungen; keine dieser Anfragen schlug fehl. Der direkte Vergleich um 20:37 Uhr scheiterte weiterhin an beiden Datenservern. Die vier Detailprüfungen bestätigten einen fertigen Spielbericht, einen älteren KL-04-Spieltag, Training 32260 und ein DBD-Ranglistenturnier. Sie liefen über die ursprünglichen Parser im Prüfprozess, nicht über eine bereits umgestellte Live-Website.

Der zeitlich begrenzte Test mit dem offiziellen WARP-Client wurde nach Sicherung der Ergebnisse beendet. Der neue dauerhafte Dienst verwendet stattdessen `wireproxy` ohne den großen offiziellen Client. Der Vorabtest dieser schlanken Variante bestätigte ebenfalls Cloudflare-WARP und beide 3K-Datenserver. Es ist keine PC-Weiterleitung oder PC-Automation eingerichtet. Aktive Live-Punkte und die echte Push-Zustellung benötigen weiterhin einen Praxistest mit laufendem Spiel.

Bei der Veröffentlichung erst den Ausgang starten und einen vollständigen Helfer-Durchlauf abwarten. Danach `DARTS_COLLECTOR_READ_ENABLED=1` setzen und die Website aktualisieren. Auf dem Server müssen die vorhandene Basis- und FCM-Override-Datei gemeinsam mit `docker-compose.darts-collector.yml` verwendet werden; `COMPOSE_PROFILES=darts-collector` aktiviert die zusätzlichen Dienste. Nur Website, Helfer und Ausgang aktualisieren. Datenbank und Sicherungsdienst bleiben bestehen. Image und Umgebung der alten Version für den Rückweg sichern. Die veröffentlichte Git-Version und parallele App-Dateien sind unmittelbar vor dem Wechsel erneut abzugleichen.

Grundlagen: [Cloudflare: Linux-Client](https://developers.cloudflare.com/warp-client/get-started/linux/), [Cloudflare: lokaler Proxy-Modus](https://developers.cloudflare.com/warp-client/warp-modes/).

## Grenzen der 3K-Anbindung

3K dokumentiert keine öffentliche API für Ergebnisse und Tabellen. Die vorhandenen öffentlichen Webseitenzugänge sind daher keine zugesicherte Schnittstelle und können sich ändern. Die offiziell angebotene Einbindung erfolgt über feste Portal-Links in einem eingebetteten Fenster. Für einen dauerhaft unterstützten eigenen Datenzugang wäre eine Abstimmung mit 3K sinnvoll.

Die verlinkte Android-App bietet Turniere, Spielerprofile und Live-Ticker. Daraus lässt sich keine freigegebene Fremdanbieter-API ableiten. Laut 3K ist ihr neuer Scorer eine WebApp, die sowohl im Browser als auch innerhalb der App geöffnet wird. Ob andere Bereiche der mobilen App zusätzliche Datenserver verwenden, ist nicht verifiziert.

Quellen:

- [3K: Schnittstelle und Einbindung in Webseiten](https://2k-dartsoftware.freshdesk.com/support/solutions/articles/103000362922-schnittstelle-api-einbindung-in-webseiten)
- [3K Darts bei Google Play](https://play.google.com/store/apps/details?id=de.twok.dartsoftware&hl=de)
- [3K: Erste Schritte mit dem Scorer](https://2k-dartsoftware.freshdesk.com/support/solutions/articles/103000411192-3k-darts-scorer-erste-schritte)
