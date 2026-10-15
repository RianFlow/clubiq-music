# TV-Studio als lokale Vorschau

Start im Repository: `node scripts/preview-tv-studio.cjs`. Die ausgegebene Adresse
öffnet die Vorschau. Der Server lauscht ausschließlich auf `127.0.0.1`.

Die Vorschau verändert weder die öffentliche Website noch deren Daten. Es gibt
keine API-, Push-, Datenbank- oder 3K-Verbindung. Namen und Vereinsfotos stammen
aus vorhandenen öffentlichen Website-Assets; sämtliche Spielstände und
Leistungswerte sind ausdrücklich Beispieldaten.

Enthalten sind ein oder zwei Boards, eine feste Mannschaftsanzeige,
Spielerporträts mit acht Sekunden Anzeigedauer und Pause/Weiter/Zurück,
kleine Leg-Einblendungen, Einzel- und Doppelsiege mit Spielerporträts und einer
kurzen Animation, eine größere Mannschaftssieg-Animation sowie ein
Pausenbildschirm mit Mannschaftsfoto und QR-Link zur öffentlichen Website.
Hell-/Dunkelmodus und Vollbild lassen sich direkt ausprobieren. Der Hellmodus
verwendet gedämpftes Salbeigrün statt großer weißer Flächen. Partiensiege sind von
Leggewinnen getrennt und aktualisieren den Mannschaftsstand. Die Beispiele für
Einzel- und Doppelsiege starten jeweils aus demselben Ausgangsstand.

Die Bedienung verschwindet nach fünf Sekunden und erscheint bei Mausbewegung,
Berührung oder den Tasten B/Tab wieder. Sie kann auch festgehalten werden.
Pfeiltasten wechseln während der Spielerpräsentation zwischen den Profilen;
Escape führt zum Spiel zurück. Reduzierte Bewegung wird berücksichtigt.

Eine spätere Übernahme in den bestehenden TV-Modus ist ein eigener Schritt.
