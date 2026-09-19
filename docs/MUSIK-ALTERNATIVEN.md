# Alternativen zur Musikquelle – Recherche vom 19.09.2026

Ziel: Raspberry bleibt zentraler Player, ClubIQ behält Abstimmung und Fernsteuerung.
Kein weiteres Abo und keine zusätzliche Plattform ohne Entscheidung des Vereins.
Es wurde nichts installiert, kein Konto verbunden und kein Kauf ausgelöst.

## Music Assistant

Läuft auf einem Raspberry oder als Home-Assistant-Erweiterung, wird per Browser
gesteuert und unterstützt mehrere Musikquellen sowie Software-Player. Als möglicher
zukünftiger Player-Unterbau interessant, nicht als garantierte YouTube-Reparatur:
Die eigene YouTube-Music-Dokumentation warnt ausdrücklich vor der inoffiziellen,
Best-Effort-Anbindung und unerwartetem Verhalten. Premium beseitigt diese technische
Einschränkung nicht. Lokale Bluetooth-Ausgabe, ClubIQ-Warteschlange, Soundboard und
Ressourcenbedarf neben der Kasse müssten separat in einer Testumgebung geprüft werden.

Quellen: [Projekt](https://www.music-assistant.io/),
[YouTube Music einschließlich Warnhinweis](https://www.music-assistant.io/music-providers/youtube-music/),
[Player-Auswahl](https://www.music-assistant.io/faq/stream-to/).

## Mopidy

Musikserver mit Raspberry-Unterstützung, lokalen Dateien, Radio und Erweiterungen.
Die HTTP/JSON-RPC-Schnittstelle bietet einen Ansatz für ClubIQ-Steuerung, wäre aber
ein neuer Adapter und kein einfacher Austausch einer Einstellung. Mopidy liefert
keinen eigenen Musikkatalog und macht fremde Streamingdienste nicht automatisch
stabil oder für öffentliche Nutzung lizenziert. Für vorhandene, entsprechend
nutzbare Musikdateien und Radio ein sinnvoller Prüfkandidat; für YouTube allein
kein belegter Vorteil gegenüber dem jetzigen Player.

Quellen: [Mopidy](https://mopidy.com/),
[Raspberry-Anleitung](https://docs.mopidy.com/latest/guides/raspberrypi/),
[HTTP-Schnittstelle](https://docs.mopidy.com/latest/reference/http/).

## Eigene Musikdateien im bestehenden ClubIQ-Player

Technische Einschätzung: Eine zusätzliche, autorisierte lokale Musikquelle würde
die Internetabhängigkeit für diese Titel beseitigen, ohne den Raspberry auszutauschen.
Dafür wären Upload/Import, Suche, Speichergrenzen, Metadaten und Quellenzuordnung der
Abstimmung umzusetzen. Gekaufte/heruntergeladene Dateien sind nicht automatisch für
jede öffentliche Wiedergabe freigegeben. Der Nutzer hatte lokale Musik zunächst
ausgeschlossen; daher nur dokumentiert, nicht implementiert.

## Ergebnis

Zuerst das begrenzte Puffer-Update im vorhandenen Player testen und die tatsächliche
Störungsursache bestimmen. Music Assistant ist ein interessanter separater Prototyp,
aber die Dokumentation belegt keine zuverlässigere YouTube-Anbindung. Mopidy wäre
vor allem für lokale Quellen/Radio interessant. Keine dieser Plattformen allein
ist eine Quelle für beliebige Musik ohne Internet, Quellenbedingungen und Rechte.

YouTube-Premium-Downloads sind nicht frei an unseren Player übertragbare Dateien:
[YouTube-Hilfe](https://support.google.com/youtube/answer/7381437?hl=de).
Die Quellen-/API-Bedingungen und die öffentliche Wiedergabe im Vereinsheim müssen
unabhängig von der verwendeten Playersoftware geklärt bleiben.
