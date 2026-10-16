# TV-Studio als lokale Vorschau

Start im Repository: `node scripts/preview-tv-studio.cjs`. Die ausgegebene Adresse
öffnet die Vorschau. Der Server lauscht ausschließlich auf `127.0.0.1`.

Die Vorschau verändert weder die öffentliche Website noch deren Daten. Es gibt
keine API-, Push-, Datenbank- oder 3K-Verbindung. Namen und Vereinsfotos stammen
aus vorhandenen öffentlichen Website-Assets; sämtliche Spielstände und
Leistungswerte sind ausdrücklich Beispieldaten.

Enthalten sind ein oder zwei Boards für eine Mannschaft sowie eine Auswahl von
zwei bis vier Mannschaften mit bis zu acht gleichzeitig sichtbaren Partien.
Zwei Mannschaften stehen nebeneinander, drei oder vier im 2×2-Raster. Jede
Mannschaft hat einen Gesamtstand und zwei Boards mit Namen, Restpunkten,
Legstand, AVG, Darts und geworfenen Punkten des aktuellen Legs. Auf schmalen
Bildschirmen stehen die Mannschaften untereinander.

Über „Siegerbeispiel für“ lässt sich die Mannschaft für die Einblendung wählen.
Bei mehreren Mannschaften erscheinen Leg-, Einzel-, Doppel- und Mannschaftssiege
im jeweiligen Mannschaftsfeld; alle anderen Partien bleiben sichtbar. Fehlende
Spieler- oder Mannschaftsfotos werden in dieser Vorschau durch das Vereinslogo
ersetzt. Die Auswahl lässt sich auch direkt mit `?teams=2` bzw. `?teams=4` öffnen
und mit `&theme=light` kombinieren.

Außerdem enthalten sind Spielerporträts mit acht Sekunden Anzeigedauer und Pause/Weiter/Zurück,
große mittige Leg-Einblendungen mit Spielerporträt (sechs Sekunden), Einzel- und
Doppelsiege mit Spielerporträts und zusätzlicher Siegeranimation (acht Sekunden),
eine große Mannschaftssieg-Animation mit vergrößertem Teamfoto sowie ein
Pausenbildschirm mit Mannschaftsfoto und QR-Link zur öffentlichen Website.
Hell-/Dunkelmodus und Vollbild lassen sich direkt ausprobieren. Der Hellmodus
verwendet gedämpftes Salbeigrün statt großer weißer Flächen. Partiensiege sind von
Leggewinnen getrennt und aktualisieren den Mannschaftsstand. Die Beispiele für
Einzel- und Doppelsiege starten jeweils aus demselben Ausgangsstand.

Die Bedienung verschwindet nach fünf Sekunden und erscheint bei Mausbewegung,
Berührung oder den Tasten B/Tab wieder. Sie kann auch festgehalten werden.
Pfeiltasten wechseln während der Spielerpräsentation zwischen den Profilen;
Escape überspringt eine Siegereinblendung oder führt zum Spiel zurück.
Reduzierte Bewegung wird berücksichtigt.

Eine spätere Übernahme in den bestehenden TV-Modus ist ein eigener Schritt.
