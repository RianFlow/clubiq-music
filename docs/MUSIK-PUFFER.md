# Musikpuffer und Diagnose

## Bedienung

Der Raspberry bleibt der Player; Handys und Tablets steuern weiterhin dieselbe
Warteschlange. Es wird kein neues Konto und kein neuer Streaminganbieter benötigt.

| Quelle | Pufferziel | Startreserve | Reserve nach Nachladen |
| --- | --- | --- | --- |
| Lieder/Playlist | 90 s | 10 s | 15 s |
| Internetradio | 30 s | 1 s | 3 s |
| Soundboard | kein Netzwerk-Vorpuffer | sofortiges Laden | kein Songprofil |

Die Zahlen bezeichnen Sekunden **Musik**, keine feste Wartezeit. Der Player lädt
so schnell wie die Quelle erlaubt. Kurze oder vollständig geladene Dateien können
auch vor Erreichen der Startreserve beginnen. Ein Live-Radiosender kann meist
nicht schneller als Echtzeit liefern. Das Ziel ist keine garantierte Reserve;
mpv begrenzt den RAM-Cache zusätzlich auf 32 MiB pro aktivem Musikstream.

Im Player werden tatsächlicher Pufferstand (Schätzung), Pufferziel und beim
Nachladen die erforderliche Reserve angezeigt. Unbekannte oder veraltete Messwerte
werden nicht als 0 Sekunden dargestellt. Startpuffer, Nachladen und manuelle Pause
sind getrennte Zustände, auch in DJ-Fernbedienung und Party-Anzeige.

Die Nachladegrenze wird erst nach messbarem Wiedergabefortschritt von 10 auf 15 s
angehoben. Ein Songwechsel, Wiederverbindungsversuch oder die Rückkehr nach einem
Soundboard-Clip beginnt erneut mit der Startreserve. Radio und Clips erhalten
eigene Dateieinstellungen und erben das Liedprofil nicht.

Die bestehende Vorbereitung des nächsten Titels ermittelt **nur die Stream-Adresse**.
Sie lädt keine Audiodatei herunter. Es gibt keinen neuen Offline-Download,
keine dauerhafte Musiksammlung und keine Weitergabe von Premium-Zugangsdaten.
Die Nutzungsbedingungen der jeweiligen Quelle gelten unverändert.

## Fehler unterscheiden

Die neuen JSON-Zeilen im Player-Journal enthalten keine Medien-URLs, Cookies,
Zugangstoken oder Mitgliedernamen. Zustände werden bei Wechseln protokolliert,
nicht bei jedem Statusabruf:

- `buffer_starting`: erster Pufferaufbau.
- `buffer_refilling`: Wiedergabe muss auf weitere Musikdaten warten.
- `buffer_ready`: cachebedingte Pause beendet; kein Beweis, dass an der Box Ton ankommt.
- `load_failed`, `stream_aborted`, `stream_premature_eof`: Laden/Stream fehlgeschlagen.
- `bluetooth_disconnected`, `bluetooth_connected`: gemeldeter Verbindungszustand der Box.
- `radio_reconnect`: erneuter Radio-Verbindungsversuch.

Auf dem Raspberry nach Installation:

```sh
sudo journalctl -u clubiq-music-player --since="15 minutes ago" --no-pager
```

Bluetooth wird etwa alle zehn Sekunden geprüft. Sehr kurze Funkstörungen können
ohne gemeldeten Verbindungsabbruch auftreten; diese Diagnose misst weder Funkqualität
noch hörbaren Ton. Größere Puffer helfen nicht gegen solche Störungen, gesperrte
Streams oder dauerhaft zu niedrige Datenraten. Die optionale Ersatzsender-Automatik
bleibt unverändert (45 s durchgehende Störung, nur wenn vorher ausdrücklich aktiviert).

## Prüfen vor Veröffentlichung

- Python-Regressionen: Profile, Pause, fehlende Messwerte, Wiedergabefortschritt,
  Wiederholversuche, kurze Songs, Radio, Soundboard und Diagnose.
- JavaScript-/Browser-Regressionen: Start- und Nachladeanzeige, Offline-/Altstatus.
- `python3 scripts/player-smoke-test.py`: echter mpv, stumme Ausgabe, temporäre
  Dateien/Sockets; keine laufende Musik oder Bluetooth-Box wird verwendet.
- Nach Installation praktischer Wiedergabetest im Vereinsheim: Pufferstand und
  zeitgleiche Player-/Bluetooth-Meldungen prüfen. Keine Aussetzerfreiheit versprechen.

Referenz: [mpv-Cache-Dokumentation](https://mpv.io/manual/master/#cache).

### Prüfstand, 19.09.2026

Alle 137 Python-Tests einschließlich der PostgreSQL-Integrationstests bestanden.
Die Datenbanktests liefen auf dem Raspberry gegen eine neue, wegwerfbare PostgreSQL-
Instanz in einem separaten internen Docker-Netz ohne veröffentlichte Ports, ohne
Produktionszugangsdaten und ohne Vereinsdaten. Testcontainer und Netzwerk wurden
anschließend entfernt. Die produktive Datenbank wurde nicht verwendet.

Alle vier JavaScript-Testsuiten, Syntaxprüfungen und der Chrome-Browsertest mit
isolierten Testdaten bestanden ebenfalls.

Der erweiterte echte mpv-Test bestand auf dem Raspberry (aarch64, mpv 0.40.0):
separater Prozess, temporärer Socket/Statusdatei und stumme Audioausgabe. Nachweis:

- Reguläres Titelende wechselt genau einmal; Playlist-Ende bleibt pausiert.
- Liedprofil 90/10/15 s; Radio und Soundboard erben das Liedprofil nicht.
- Sehr kurze vollständig geladene Dateien starten ohne künstliche Zehn-Sekunden-Pause.
- Eine künstlich langsame HTTP-Quelle auf Loopback erzeugt einen echten Pufferabriss.
- Neun Sekunden nachgelieferte Musik reichen nicht zum Fortsetzen; erst weitere
  Daten beenden die Pause. Danach wurden tatsächlich 90 s Puffer gemessen.
- Kein Titelwechsel/Neustart bei diesem Nachladen. Eine fehlende Datei wird genau
  einmal erneut versucht und anschließend angehalten.

mpv liefert die ausgeschaltete Cache-Option im JSON-IPC als `false`; die Testprüfung
akzeptiert diesen Wert sowie die textuelle Darstellung `no`.

Keine Installation des Updates und kein Neustart produktiver Dienste in diesem
Prüfschritt. Ein hörbarer Praxistest mit der Vereinsheim-Box steht noch aus.
