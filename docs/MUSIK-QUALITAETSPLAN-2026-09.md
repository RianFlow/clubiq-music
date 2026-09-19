# ClubIQ Music: stabiler Vereinsabend, einfache Bedienung

Stand: 15. September 2026. Codeprüfung und lokale Tests; keine Aussage über den
aktuellen Funkempfang oder den laufenden Softwarestand im Vereinsheim.

## Leitlinie

Die drei Bereiche bleiben getrennt: **Abstimmen** sammelt Wünsche, **Playlists**
bewahrt Ergebnisse, **Player** steuert die tatsächliche Wiedergabe. Die letzten
fünf Playlists, Radio-Suche, gespeicherte Boxen und echte Soundboard-Aufnahmen
sind bereits vorhanden und werden weiter genutzt. Offline-Musik bleibt wie
gewünscht außerhalb des aktuellen Pakets.

## Paket 1: Wiedergabe und Verbindungsfehler (lokal umgesetzt)

- Wiedergabe und Warteschlange stehen vor dem Radio, damit zentrale Bedienelemente
  schneller erreichbar sind.
- Die Statuskarte unterscheidet Box getrennt, Laden, Nachpuffern, Pause,
  Stummschaltung und eine unterbrochene Verbindung der Bedienoberfläche.
- Sichtbar sind der geschätzte Audiopuffer, das Ziel von 30 Sekunden und der
  Zeitpunkt der letzten Statusantwort. Fehlende Messwerte erscheinen nicht als 0.
- Songs starten mit einem kleinen Puffer (Ziel: 3 Sekunden); nach einem
  Pufferabriss wird ebenfalls diese Reserve angestrebt. Das ist keine feste
  dreisekündige Wartezeit und keine Garantie gegen schwaches Internet.
- Die nächste YouTube-Stream-Adresse wird erst bei mindestens 10 Sekunden
  aktueller Reserve oder vollständig gepuffertem Titel vorbereitet. Während
  Nachpuffern wird kein neuer Vorbereitungsvorgang gestartet. Ein bereits
  laufender Hintergrundvorgang wird dabei nicht abgebrochen.
- „Stream-Adresse vorbereitet“ heißt ausdrücklich nicht, dass der nächste Song
  bereits heruntergeladen ist. Audio wird weiterhin im RAM gepuffert, kein
  dauerhaftes Musikarchiv angelegt.
- Wiederholung, Zufallsmodus und Radio erhalten passende Hinweise zur nächsten
  Wiedergabe, statt immer den nächsten Listeneintrag anzukündigen.
- Langsame Statusabfragen überlappen nicht; bei Ausfällen steigen die Abstände
  bis auf 30 Sekunden. Beim Zurückkehren in die App wird sofort neu geprüft.
- Versteckte Ansichten fragen nicht ständig weiter ab. Gespeicherte Boxen werden
  höchstens einmal pro Minute automatisch und weiterhin manuell aktualisiert.
- Eine Aktualisierung derselben Playlist lässt die sichtbaren Songs und den
  Suchfilter stehen. Beim Wechsel zu einer anderen Playlist wird weiterhin neu
  geladen; alte Songs werden nicht unter einer falschen Überschrift angezeigt.
- Netzfehler und Serverfehler löschen keine Mitgliedsanmeldung. Ein vom Server
  bestätigtes ungültiges Mitgliedstoken (401) wird weiterhin verworfen.
- API-Antworten haben ein Zeitlimit; ungültiges JSON/HTML wird als Fehler behandelt.
  Schreibaktionen werden niemals automatisch wiederholt, da sie trotz verlorener
  Antwort bereits ausgeführt worden sein könnten.
- DJ-Fernbedienung und Party-Anzeige behalten bei Ausfällen den letzten bekannten
  Stand bei und kennzeichnen ihn. Die Serverrechte bleiben unverändert.

Technische Grundlage für Pufferoptionen und Messwertgrenzen:
[mpv-Handbuch: Cache](https://mpv.io/manual/stable/#cache) und
[mpv-Handbuch: Properties](https://mpv.io/manual/stable/#properties).
Der gemeldete Puffer ist eine Schätzung. 30 Sekunden Ziel können bei Live-Radio,
Dateiende oder begrenzter Datenrate unterschritten werden. Ein voller Puffer
behebt keine Bluetooth-Funkstörung.

## Nächste Pakete, in dieser Reihenfolge

| Priorität | Verbesserung | Woran wir den Nutzen messen |
| --- | --- | --- |
| 2 | Abnahme unter echten Vereinsbedingungen: längere Wiedergabe, Senderwechsel, Box aus/an, kurze Internettrennung; getrennte Messung von Netzwerk- und Audioausfällen | Kein unbeabsichtigtes Überspringen, nachvollziehbarer Grund für jede Unterbrechung, selbstständige Erholung nach kurzer Netzstörung |
| 3 | Ein „Vereinsabend starten“-Ablauf: gespeicherte Box, ausgewählte Playlist oder Sender, letzte Lautstärke bestätigen; optionale Ersatzquelle nur nach bewusster Freigabe | Ein Helfer kann den Abend ohne SSH und ohne Erklärung starten; keine überraschende Wiedergabe beim Booten |
| 4 | Persönliche DJ-Rechte auch für die separate Fernbedienung, bessere Sitzungs-/Zugangsverwaltung und erneute Prüfung der öffentlich erreichbaren API | Kein gemeinsam weitergegebenes Verwaltungskennwort für normale DJs; Rollenwechsel wirkt serverseitig |
| 5 | Eigene Senderfavoriten und Sound-Favoriten; übersichtliche Abendhistorie und einfache Wiederverwendung bewährter Musik | Häufig benötigte Aktionen in wenigen Berührungen; vorhandene Abstimmungen bleiben unverändert |
| 6 | Kontrollierte Updates mit Funktionsprüfung und Rückkehr zur vorherigen Version; Langzeittest der Ressourcenbelastung | Musik-Updates beeinträchtigen die Vereinskasse nicht; ein fehlgeschlagener Start ist erkennbar und rückgängig zu machen |

Keine dieser späteren Funktionen ist mit diesem Paket bereits als fertig
versprochen. Insbesondere sind nahtlose Übergänge/Crossfade oder das vollständige
Vorab-Laden weiterer YouTube-Titel separate technische und nutzungsrechtliche
Entscheidungen.

## Prüfung und Veröffentlichung

Nachfolgepaket: Der geführte Abendstart, persönliche Songfavoriten und der
Wiedergabeverlauf sind separat in [MUSIK-ABENDSTART.md](MUSIK-ABENDSTART.md)
beschrieben. Die folgenden Prüfhinweise beziehen sich auf das ursprüngliche
Zuverlässigkeitspaket; das Nachfolgepaket ergänzt zwei Datenbanktabellen.

Lokale Prüfungen: Python-Regressionssuite, JavaScript-Syntax, UI-Tests für
Anmeldungen/Verbindungen/Abstimmungsarchive und echter Chrome-Browsertest mit
Testdaten einschließlich schmalem Display, Radio-/Player-Status, Sound-Decodierung
ohne Tonausgabe und simulierten 503-Antworten. Tests mit PostgreSQL und echtem
Linux-mpv laufen zusätzlich in der vorhandenen GitHub-Prüfung; sie ersetzen keinen
Hörtest mit der Bluetooth-Box im Vereinsheim.

Dieses Paket ändert `player_agent.py` **und** die Weboberfläche. Nur den
Webcontainer neu zu bauen reicht nicht. Vor Freigabe: Linux-mpv-Test grün, keine
laufende Vereinsveranstaltung unterbrechen, bisherigen Player sichern, neuen
Player installieren und den Dienst einmal kontrolliert neu starten. Datenbank,
Musiklisten, Kopplungen und Cloudflare-/Tailscale-Einstellungen werden von diesem
Paket nicht migriert oder umgestellt.
