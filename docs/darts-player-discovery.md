# Automatisches Finden externer Turnierteilnahmen

Untersuchung vom 15.10.2026. Noch kein aktivierter Suchdienst.

## Konkretes Beispiel

3K führt „Donnerstag Rangliste #9 (Doppel)“ beim BrenndorfDartClub:

- Live: https://live.3k-darts.com/event/1/38718
- Teilnehmer: https://portal.3k-darts.com/frontend/events/1/event/38718/participants
- Datenbank 1, Veranstaltung 38718, Veranstalter 1100; 17 Doppel in der Teilnehmerliste.
- Jasmin Kölle / Merle Brammeyer, Tim Thürkow / Otto Dieckmann und
  Jörg Renzelmann / Max Lowak stehen auf dieser öffentlichen Teilnehmerliste.
- Jasmin, Merle, Tim und Jörg stimmen mit den Namen der veröffentlichten
  Barver-Profile überein. Eine Barver-Vereinsangabe wird zum Finden nicht benötigt.

Die aktuelle Live-Liste und die Spiele dieses Turniers wurden auch direkt vom
laufenden Server abgerufen, über dessen vorhandene 3K-Verbindung:

```
GET https://live.3k-darts.com/dartsscorer-liveticker/api/v1/group?eventType=TURNIER
GET https://live.3k-darts.com/dartsscorer-liveticker/api/v1/match/1/0/38718
```

Die erste Antwort enthielt beim Prüfen 84 Turniergruppen. Die zweite enthielt
fünf Spielanzeigen, darunter Jasmin und Merle. Die 3K-Weboberfläche verwendet
inzwischen auch `live-backend.3k-darts.com` für dieselben öffentlichen Lesewege.
Die bestehenden Website-Lesewege über `live.3k-darts.com` funktionierten im Test.

## Zuordnung und Grenzen

Die Teilnehmerliste stammt aus
`backend1.3k-darts.com/2k-backend1/api/v1/frontend/event/38718/participant`.
Sie wurde im öffentlichen Browser vollständig geladen. Die gezielte direkte
Serverabfrage endete im Verbindungstimeout. Dieser Host gehört derzeit nicht
zu den gezielt über die alternative Verbindung geführten 3K-Quellen.
Vor einer Zusage, schon jede Anmeldung zu finden, muss dieser Leseweg ebenfalls
zuverlässig angebunden und vom Server geprüft werden.

Das Doppel Jasmin / Merle besitzt eine gemeinsame Teilnehmernummer (`739166`).
Die hier sichtbaren Teilnehmerfelder enthalten keine beiden einzelnen
Stammspieler-IDs. Die IDs der Spieler in der Live-Anzeige sind wiederum
spielbezogen. Sie dürfen nicht mit den Barver-Kadernummern gleichgesetzt werden.
Eine Identität muss gegebenenfalls je 3K-Datenbank gespeichert werden.

Die Live-Kurzform „J. Kölle & M. Brammeyer“ reicht allein für eine sichere
Zuordnung nicht aus. `allInOneMatchdata` lieferte bei diesem Spiel die vollständigen
Namen „Jasmin Kölle & Merle Brammeyer“. Bei neu vorbereiteten Spielen kann diese
Zusatzinformation noch fehlen. Namensgleichheit bleibt grundsätzlich möglich.

## Sinnvolle Umsetzung

1. Die vorhandenen veröffentlichten Vereinsprofile als Ausgangsliste nutzen.
   Geprüfte alternative Schreibweisen einmalig pro Spieler hinterlegen.
2. Ein eigener Serverdienst liest die öffentliche Turnierübersicht regelmäßig,
   beispielsweise alle fünf Minuten. Begrenzte parallele Abfragen, Zeitlimits,
   Zwischenspeicherung und zunehmende Wartezeiten bei Fehlern vermeiden Lastspitzen.
3. Teilnehmerlisten und veröffentlichte Live-Spiele gegen die Vereinsprofile
   abgleichen; beide Partner eines Doppels getrennt prüfen. Niemals nur nach
   „Barver“ beim Veranstalter oder nach einem Nachnamen suchen.
4. Stabile Kennungen bevorzugen, wenn sie nachweislich dieselbe Person bezeichnen.
   Bei ausschließlich lesbaren Namen eindeutige vollständige Namen und bestätigte
   Schreibweisen verwenden; unklare Treffer zur Prüfung markieren.
5. Gefundene Teilnahmen dauerhaft und mit ihrer Quelle speichern; eine eigene
   Anzeige „Unsere Spieler unterwegs“ kann daraus Spiele und Ergebnisse anbieten.
   Eine erfolglose Abfrage darf eine bereits bestätigte Teilnahme nicht löschen.
6. Live- und Push-Abonnements erst an bestätigte Zuordnungen binden; keine
   Benachrichtigungen für bloß ähnliche Namen erzeugen.

Alles läuft auf dem Server. Private 3K-Konten, App-Zugangsdaten und ein dauerhaft
eingeschalteter PC sind dafür nicht vorgesehen. Öffentlich unsichtbare Anmeldungen
und nicht veröffentlichte Spiele können so nicht erkannt werden.
