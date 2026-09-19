# Abendstart und persönliche Musik

## Vereinsabend starten (freigegebene DJs)

1. Box einschalten. Im Bereich **Player** auf **Vereinsabend starten** tippen.
2. Eine bereits gekoppelte Box und eine verfügbare Playlist oder einen gespeicherten Radiosender wählen.
3. Startlautstärke prüfen (Vorgabe bewusst 40 %, nicht die möglicherweise hohe letzte Lautstärke).
4. Optional bei einer Playlist einen Ersatzsender auswählen. Standard ist **aus**.
5. Zusammenfassung prüfen und **Jetzt mit diesen Einstellungen starten** bestätigen.

Erst die Bestätigung verändert den Player. Dabei wird die bisherige Musik ersetzt,
Stummschaltung aufgehoben und Zufall/Wiederholung ausgeschaltet. Andere Nutzer
benötigen weiterhin eine ausdrückliche Player-Freigabe. Eine neue Bluetooth-Box
wird zuerst in der Verwaltung gekoppelt; der Abendstart sucht nicht nach fremden Geräten.

Bei einem Verbindungsfehler erscheint die Meldung direkt im Dialog. Nach einem
HTTP-Zeitlimit zuerst den Playerstatus prüfen: Der Auftrag kann bereits angekommen
sein. Die unveränderte Bestätigung verwendet dieselbe Auftrags-ID und startet einen
bereits angenommenen Abend nicht erneut. Ändern der Auswahl erzeugt einen neuen Auftrag.
Die letzten 50 angenommenen Aufträge bleiben dafür auch nach einem Dienstneustart
gespeichert; ein verzögerter Wiederholversuch überschreibt nicht den neueren Abend eines anderen DJs.

## Optionaler Ersatzsender

- Nur nach ausdrücklicher Auswahl im Abendstart, nur für Playlist-Wiedergabe.
- Nach 45 Sekunden durchgehender Lade-/Stream-Störung erfolgt ein Wechselversuch.
- Eine manuelle Pause, Soundboard-Wiedergabe und reguläres Playlist-Ende lösen keinen Wechsel aus.
- Bei getrennter Bluetooth-Box wird nicht auf Radio gewechselt.
- Radio braucht ebenfalls Internet. Es ist kein Offline-Ersatz und kann bei einem Totalausfall ebenfalls nicht spielen.
- Keine Wechsel-Schleife und kein automatischer Rücksprung. **Radio beenden** kehrt zur pausierten Playlist zurück; anschließend **Start** drücken.
- Im Player jederzeit ausschaltbar. Nach Neustart des Player-Dienstes ist die Automatik wieder ausgeschaltet. Ein bereits laufender Radiosender bleibt als normale Quelle gespeichert.

## Meine Musik

**☆ Merken** speichert einen YouTube-Song im persönlichen Mitgliedskonto. Unter
**Meine Musik** erscheinen bis zu 200 Favoriten, unabhängig vom verwendeten Gerät.
Von dort können sie während einer geöffneten Abstimmung erneut vorgeschlagen werden.
Die Funktion erteilt keine Player-Rechte und verändert keine laufende Warteschlange.

Der gemeinsame Verlauf zeigt tatsächlich gestartete Songs und Radiosender im
Vereinsheim, nicht lediglich geladene Playlists. Er ist nur angemeldeten Mitgliedern
zugänglich. Radiosender werden als Sender erfasst; deren einzelne Lieder werden
nicht aus Metadaten als eigene Einträge erfunden. Der Verlauf beginnt erst mit
Installation dieses Updates, frühere Abende lassen sich nicht nachträglich rekonstruieren.

Abgleich etwa alle 30 Sekunden, Aufbewahrung in der Datenbank 90 Tage, Anzeige bis
zu 200 Starts je ausgewähltem Tag (Zeitzone Europe/Berlin, Sommerzeit berücksichtigt).
Der Player hält zusätzlich einen Ringpuffer der letzten 500 Starts auf dem Raspberry
vor, damit ein kurzer Ausfall der Weboberfläche keine Einträge verliert. Bei längerer
Trennung mit mehr als 500 Starts können ältere, noch nicht synchronisierte Einträge
entfallen. Wiederverbindungen, Nachladeversuche und Soundboard-Unterbrechungen
erzeugen für den laufenden Titel keine künstlichen Doppeleinträge.

## Songvorschläge und Tablet-Bedienung

- Suche zeigt Laufzeiten, soweit YouTube sie bereitstellt. Ein Ausfall der zusätzlichen Metadatenabfrage blockiert nicht die gesamte Suche.
- Hinweise wie Live, Remix oder Cover werden aus dem Titel abgeleitet und entsprechend gekennzeichnet, nicht als geprüfte Version versprochen.
- Identische YouTube-IDs werden als bereits vorgeschlagen markiert; sehr ähnliche normalisierte Titel lösen eine Bestätigungsfrage aus. Die Erkennung ist bewusst konservativ und keine akustische Musikerkennung.
- Ein kleiner Player außerhalb des Player-Bereichs zeigt die aktuelle Musik und bietet Start/Pause für freigegebene DJs. Mitglieder können den aktuellen YouTube-Song merken.
- Formulare haben beschriftete Felder und mindestens 44 Pixel hohe wesentliche Schaltflächen.

## Betrieb, Sicherung und Veröffentlichung

Neue Tabellen `music_member_favorites` und `music_playback_history` werden von
`bootstrap.py` zusätzlich angelegt; bestehende Vereins-/Musikdaten bleiben erhalten.
Die normale vollständige PostgreSQL-Sicherung umfasst beide Tabellen automatisch.
Favoriten werden beim Löschen ihres Mitgliedskontos mit entfernt. Der gemeinsame
Verlauf enthält keine Mitgliedsnamen und keine signierten Stream-URLs/Zugangsdaten.

Webcontainer **und** `/usr/local/lib/clubiq-music-player.py` müssen aktualisiert
werden. Vorher Datenbanksicherung prüfen, alten Player/Container für Rückkehr sichern,
Linux-mpv- und PostgreSQL-Tests ausführen, Musikunterbrechung abstimmen. Die lokale
Windows-Suite überspringt diese Linux-/PostgreSQL-Prüfungen; sie laufen in GitHub CI.
Ein grüner automatischer Test ersetzt keinen Hörtest an der echten Vereinsbox.

Nach Installation prüfen: Favorit anlegen/auf zweitem Gerät sehen; Abendstart mit
niedriger Lautstärke; gespielten Titel nach ca. 30 Sekunden im Verlauf finden;
Pause darf keinen Ersatzsender auslösen. Ein Fallback-Test erfolgt nur bewusst in
einer ruhigen Testphase, nicht durch Abschalten des gesamten Kassen-Netzwerks.
