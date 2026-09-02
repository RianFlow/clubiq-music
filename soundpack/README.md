# ClubIQ Darts & Party · echte Aufnahmen (Pack 2)

13 kurze Aufnahmen ersetzen das synthetische Pack 1. Keine Sprachsynthese,
KI-Stimmen, Zufallsgeräusche oder aus Fernsehübertragungen kopierten Ansagen.
Alle Sounds stammen von den unten genannten Urhebern und sind keine eigenen
ClubIQ-Aufnahmen. „Dart-Treffer“ ist ein echter Scheibentreffer, keine 180-Ansage.

| Button | Originalaufnahme / Urheber | Lizenz |
| --- | --- | --- |
| Dart-Treffer | [Darts.wav · aidansamuel](https://freesound.org/people/aidansamuel/sounds/540132/) | CC0-1.0 |
| Pfeile auf die Scheibe | [dart hits.wav · bsumusictech](https://freesound.org/people/bsumusictech/sounds/62455/) | CC0-1.0 |
| Jubel & Applaus | [cheering and clapping crowd 1 · AlaskaRobotics](https://freesound.org/people/AlaskaRobotics/sounds/221568/) | CC0-1.0 |
| Applaus im Club | [Applause · KentVideoProduction](https://freesound.org/people/KentVideoProduction/sounds/199277/) | CC0-1.0 |
| Trommelwirbel | [buzz roll.wav · bigjoedrummer](https://freesound.org/people/bigjoedrummer/sounds/77305/) | CC0-1.0 |
| Sieges-Hupe | [Industrial Air Horn · mcpable](https://freesound.org/people/mcpable/sounds/131930/) | CC0-1.0 |
| Rimshot | [Rimshot (sweet) · Sajmund](https://freesound.org/people/Sajmund/sounds/132418/) | CC0-1.0 |
| Pech gehabt! | [Sad Trombone.wav · Benboncan](https://freesound.org/people/Benboncan/sounds/73581/) | CC-BY-4.0 |
| Ansteckendes Lachen | [WOMAN LAUGH · SamuelGremaud](https://freesound.org/people/SamuelGremaud/sounds/468514/) | CC0-1.0 |
| Publikum lacht | [Female crowd laughing · kikorurelas](https://freesound.org/people/kikorurelas/sounds/767470/) | CC0-1.0 |
| Buh-Rufe | [crowd booing · HowardV](https://freesound.org/people/HowardV/sounds/264378/) | CC0-1.0 |
| Rutsch-Pfeife | [slide whistle.wav · jcookvoice](https://freesound.org/people/jcookvoice/sounds/586529/) | CC0-1.0 |
| Peinliche Stille | [crickets · selcukartut](https://freesound.org/people/selcukartut/sounds/504882/) | CC0-1.0 |

Lizenztexte: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
und [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Die Audio-Lizenzen gelten unabhängig von der Software-Lizenz. Bei Weitergabe
insbesondere Benboncans Namensnennung, Quellenlink, Lizenzlink und
Bearbeitungshinweis erhalten. Es wird keine Unterstützung/Empfehlung der App
durch die Urheber behauptet.

## Bearbeitung und Nachweis

Verwendet werden die auf den Originalseiten öffentlich verlinkten HQ-MP3-
Vorschauen, nicht die nur nach Anmeldung herunterladbaren Originaldateien.
Die Quellen/Lizenzen wurden am 02.09.2026 geprüft. Das Manifest enthält pro
Clip Originaltitel, Urheber, Quellen- und Download-Link, Lizenz, Hinweise zur
Aufnahmetechnik sowie SHA-256 der Quelldatei und des bearbeiteten WAVs.

Bearbeitung: bei längeren Aufnahmen ein kurzer Anfangsausschnitt, Umwandlung
in Mono-WAV (22.050 Hz, 16 Bit), Pegelangleichung und kurze Randblenden.
Keine neuen Klänge oder Stimmen werden hinzugefügt. Aktiver RMS-Zielpegel
ca. -21 dBFS, Spitzen maximal -6 dBFS. Dauer etwa 1–9 Sekunden.
Die tatsächliche Lautstärke hängt weiterhin von Player und Box ab.

Maintainer können das Paket mit FFmpeg erneut importieren:

```bash
python scripts/import-recorded-soundpack.py --ffmpeg /path/to/ffmpeg
```

Das ist **kein** Installationsschritt auf dem Raspberry. App und Docker-Build
nutzen nur die eingecheckten Dateien; beim Start ist kein Internet nötig.
Die HTML-Quellenliste unter `/static/soundboard-credits.html` wird mit erzeugt.

## Bestehende Installationen

Fehlende Pack-2-IDs werden einmalig eingefügt. Bereits entfernte Pack-2-Buttons
bleiben entfernt. Die exakt bekannten Pack-1-IDs werden nur deaktiviert;
ihre Audio-Daten bleiben für eine Wiederherstellung in der Datenbank/Sicherung.
Eigene Uploads und andere Pakete werden weder verändert noch gelöscht.
Die synthetischen WAVs werden nicht mehr mit dem neuen Build ausgeliefert.

Für echte „180!“, „Game Shot!“ oder Barver-Ansagen bitte eigene Aufnahmen oder
ein entsprechend lizenziertes Sprecherpaket über die Verwaltung hochladen.
