# ClubIQ Darts & Party · Pack 1

32 kurze, lokal mitgelieferte WAV-Clips (Mono, 22,05 kHz, 16 Bit).
22 synthetische Ansagen und 10 eigens programmierte Arcade-Effekte.
Keine TV-Kommentatoren, bekannten Stimmen, Musikstücke oder fremden Sound-Samples.
Die Ansagen klingen bewusst synthetisch, nicht wie echte Stadionsprecher.

- **Darts:** 180, 140, 100, 60, Bullseye, Checkout, Game Shot, Game On,
  Matchdart, Doppel, Triple Twenty, Neun-Darter, überworfen, Madhouse,
  Good Darts, nächste Runde und drei Pfeiltreffer.
- **Jubel:** Barver-Ansage, Siegesfanfare, synthetischer Mini-Applaus,
  Trommelwirbel, Level Up und kurze Party-Tröte.
- **Spaß:** die klassische 26, Warmwerfen, schiefe Scheibe, Nachrechnen,
  knapp daneben, Ba-dum-tss, Pech gehabt, Boing und Grillenzirpen.

Erzeugung: `scripts/generate-soundpack.py` mit Python-Standardbibliothek und
[eSpeak NG 1.52.0](https://github.com/espeak-ng/espeak-ng/releases/tag/1.52.0)
(Formantsynthese; Stimmen `de` und `en-gb`, keine MBROLA-Stimmen).
[eSpeak-Dokumentation](https://espeak.sourceforge.net/commands.html) und
[Lizenz des Werkzeugs](https://espeak.sourceforge.net/license.html).
Es werden nur die generierten Audioausgaben verteilt, nicht das Sprachwerkzeug.
Alle gesprochenen Texte sind im Manifest dokumentiert.

Neu erzeugen, wenn eSpeak NG installiert ist:

```bash
python scripts/generate-soundpack.py --espeak espeak-ng
```

Pegel: aktiver RMS-Zielpegel ca. -21 dBFS, Spitzen maximal -6 dBFS.
Die tatsächliche Lautstärke hängt weiterhin von Player und Box ab.
Jeder Clip hat eine SHA-256-Prüfsumme in `manifest.json`.

Beim App-Start werden fehlende Pack-IDs einmalig in die Datenbank übernommen.
Eigene Uploads werden nicht verändert. Entfernen blendet einen Clip dauerhaft aus,
auch nach Neustarts/Updates; seine Pack-ID wird nicht erneut eingefügt.
