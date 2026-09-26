# Spielerprofile pflegen

## Spielerbilder

- Ideales Format: Hochformat 4:5, zum Beispiel 1200 × 1500 Pixel.
- Mindestgröße: 800 × 1000 Pixel.
- Empfohlen: WebP oder JPG. Ein freigestelltes WebP/PNG mit transparentem Hintergrund wirkt in der großen Profilkarte besonders professionell.
- Gesicht und Oberkörper mittig aufnehmen und oberhalb des Kopfes etwas Platz lassen.
- Dateien ausschließlich unter `pics/players/` ablegen. Kurze Dateinamen ohne Leerzeichen verwenden, zum Beispiel `tim-thuerkow.webp`.

## Alias und Average

Die Datei `static/darts-players.json` ordnet die Angaben über die öffentliche 3K-Spieler-ID zu:

```json
{
  "players": {
    "123456": {
      "image": "/pics/players/tim-thuerkow.webp",
      "alias": "The Captain",
      "average": 61.3
    }
  }
}
```

- `image`: lokaler Bildpfad unter `/pics/players/`.
- `alias`: maximal 50 Zeichen; erscheint prominent über dem Namen.
- `average`: aktueller 3-Dart-Average als Zahl zwischen 0 und 180.

Fehlende Angaben werden nicht erfunden. Ohne Bild erscheinen die Initialen, ohne Average steht im Profil „Noch offen“. Der Average kann zunächst gepflegt werden; eine automatische Saisonberechnung aus verifizierten 3K-Spielberichten kann später ergänzt werden.
