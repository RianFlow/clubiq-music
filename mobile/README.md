# Barver Darts – native App-Grundlage (0.1)

## Stand

Separate, lokal gebündelte Capacitor-Oberfläche für Android und iOS. Kein eingebetteter
Verwaltungszugang und keine administrative API. Die produktive Website bleibt unverändert.
**Android-Test-APK lokal gebaut. Keine Store-Veröffentlichung/IPA; echte native Pushzustellung noch nicht eingerichtet oder am Handy bestätigt.**

- Startseite, Spiele, vier Mannschaften, Kader und persönliche Spielerangaben.
- Alle gleichzeitig aktiven Boards mit Leg-Punkten, Spielbericht mit Averages.
- Lieblingsmannschaft, Team-/Spieler-/Ereignisauswahl, öffentliche Highlights.
- Lokaler letzter bekannter Datenstand; automatische erneute Versuche im Vordergrund.
- Öffentliche Daten ausschließlich vom bestehenden ClubIQ-Server. Kein direkter 3K-Abruf pro Gerät.
- Eigene lokale Oberfläche statt beliebiger fremder Webseiten in einer privilegierten WebView.
- Android-Push-Anbindung, Aktivierung/Abmeldung, Testmeldung und lokaler Empfangsverlauf implementiert;
  ohne Firebase-Datei und Serverkonfiguration bewusst gesperrt.

## Lokal starten

Im Ordner `mobile`:

```text
npm ci
npm test
npm run build
npm run preview
```

Die ausgegebene 127.0.0.1-Adresse zeigt öffentliche **Echt-Daten**, keine fingierten Ergebnisse.
Der lokale Vorschau-Proxy akzeptiert nur freigegebene lesende Endpunkte und keine Verwaltungsrouten.
In nativen Builds erfolgt der Datenabruf über CapacitorHttp. Kein offener CORS- oder Serverumbau erforderlich.

## Android und iOS erzeugen

Android: Android Studio/SDK installieren, `npm run android:init`, `npm run sync`, `npm run android`.
iOS: auf einem Mac mit passendem Xcode `npm run ios:init`, `npm run sync`, `npm run ios`.

### Lokale Android-Test-APK

Nach `cap sync android` immer `npm run android:prepare` ausführen. Damit werden das
Vereinslogo, der dunkle Startbildschirm, HTTPS-only, deaktivierte Cloud-Sicherung,
die Testversionsnummer und der lokale Debug-Schlüsselpfad auf das erzeugte Projekt
übertragen. Die Quelldateien dafür liegen in `android-overrides/`.
Die Gradle-Distribution 9.1.0 ist per SHA-256 festgelegt und vermeidet den
Windows-Dateisperrfehler des ursprünglichen 8.14.3-Templates.

Mit Java 21 und Android SDK 36: im Ordner `android/` unter Windows
`gradlew.bat --no-daemon --console=plain --max-workers=2 assembleDebug` ausführen.
SDK und Java können portabel verwendet werden; Android Studio ist für diesen
Kommandozeilen-Testbau nicht nötig. Resultat: `android/app/build/outputs/apk/debug/app-debug.apk`.
Vor dem allerersten Bau muss der lokale Testschlüssel erzeugt werden, falls er
noch nicht vorhanden ist. Im Ordner `android/` mit dem JDK-Werkzeug `keytool`:
`keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 3072 -validity 3650 -storetype JKS -dname "CN=Barver Darts Test,O=ClubIQ,C=DE"`.
Dies sind ausschließlich die Standard-Testpasswörter, keine Produktionssignatur.
Einen vorhandenen Schlüssel niemals durch einen neuen ersetzen.

Diese APK ist mit einem **lokalen Debug-Schlüssel** signiert, nicht für den Store
bestimmt. Den Schlüssel in `android/debug.keystore` für weitere Testupdates erhalten,
niemals veröffentlichen. APK und native Builddateien bleiben lokal und ignoriert.
Auf dem Handy kann die APK direkt installiert werden; die Erlaubnis „Unbekannte
Apps installieren“ nur für die verwendete Datei-/Browser-App geben und anschließend
wieder abschalten. Es ist kein Google-Play-Login nötig.
Ein erstes Gerätetest-Ergebnis liegt erst nach Installation auf einem echten Handy vor.
App-ID vor Anmeldung in den Stores verbindlich festlegen: aktuell `party.clubiq.barverdarts`.
Die erzeugten nativen Projekte sind vorläufig lokale Artefakte. Sobald native Anpassungen verbindlich
sind, diese ohne Signaturdateien/Firebase-Dateien gezielt ins Repository übernehmen.

## Android-Push einrichten

Die vollständige Einrichtung steht in [ANDROID-PUSH-EINRICHTUNG.md](../docs/ANDROID-PUSH-EINRICHTUNG.md).
Firebase-App-Datei lokal ablegen, private Server-Zugangsdaten getrennt einbinden,
Backend installieren und APK neu bauen. Dafür ist noch kein Play-Store-Entwicklerkonto nötig.
Eine vorhandene Test-APK ohne Firebase-Konfiguration aktiviert Push nicht nachträglich.

Der Transport verwendet ausschließlich vier eigene öffentliche Native-Push-Endpunkte;
Geräteänderungen benötigen einen zufälligen 256-Bit-Geräteschlüssel. Die Aktivierung
fragt erst nach Android-Erlaubnis, wenn App und Server konfiguriert sind. Der Server
nutzt dieselben Sportereignisse wie Web-Push, mit eigener dauerhafter Versandwarteschlange.
„Angemeldet“ heißt Registrierung bestätigt, nicht Zustellung am Handy garantiert.
Die Testmeldung ist auf das eigene angemeldete Gerät begrenzt.

Ohne Firebase-Konfiguration werden keine Gerätetokens abgefragt oder übertragen.
Für iOS fehlen noch APNs-Zugang, Signing, native Konfiguration und Gerätetests.
Apple-/Firebase-Privatschlüssel und Signaturdateien gehören ausschließlich in geschützte lokale
Dateien bzw. Server-/CI-Secrets – niemals ins Repository oder in den Chat.

## Grenzen dieser Vorschau

Beim Antippen einer Begegnung erscheinen sofort alle laufenden Boards mit Spielern,
Punkten im aktuellen Leg, Legstand, Average, letztem Wurf und Markierung „Am Wurf“.
Live-Daten aktualisieren sich im Vordergrund alle 15 Sekunden, der Spielbericht alle
60 Sekunden. Ein langsamer/fehlender Spielbericht blockiert die Live-Anzeige nicht.
Bei Verbindungsfehlern bleibt der letzte Stand mit Hinweis sichtbar; veraltete Boards
werden nicht als frisch live ausgegeben. Ohne öffentliche 3K-Live-Daten können keine
Punkte erfunden oder angezeigt werden.

Noch keine eigene Turnieransicht oder detaillierte Tabellen/Spielerstatistiken in der App;
Turnier und rechtliche Seiten öffnen gezielt im Systembrowser. Der lokale Meldungsverlauf
enthält nur in der geöffneten App empfangene oder angetippte Meldungen, nicht jede
ungeöffnete Hintergrundmeldung. Keine bestätigte Pushzustellung ohne Firebase und Gerätetest. Die vorbereitete
App ist eine erste Grundlage und ersetzt nicht die vollständigere Website.

Offizielle Grundlagen:
- https://capacitorjs.com/docs/apis/push-notifications
- https://capacitorjs.com/docs/getting-started/environment-setup
- https://developer.apple.com/app-store/review/guidelines/#minimum-functionality


## TV-Modus in der Web-App

In der Web-App öffnet **TV** oben im Kopfbereich oder **TV-Modus öffnen** auf der
Startseite die Live-Ansicht der Website. Sie bleibt unter `/app/live` innerhalb
der installierten Web-App. **Zurück zur App** führt zur kompakten Übersicht zurück.
Die Lieblingsmannschaft ist vorausgewählt; A–D und Alle ändern die Auswahl.
Eine laufende Partie erscheint automatisch. Der Modus benötigt eine Verbindung,
funktioniert aber auch ohne Unterstützung der browserseitigen Vollbildfunktion.

Auf dem Handy bleiben die Boards zunächst kompakt. Antippen oder **Vergrößern**
zeigt die großen Restpunkte und weiteren Wurfwerte; **Verkleinern** stellt die
Übersicht wieder her. Die Auswahl bleibt während Live-Aktualisierungen erhalten.
Eine neue Partie auf demselben Board beginnt wieder kompakt. Ein entscheidender
Legstand beendet die Anzeige gemäß Best-of-/First-to-Modus, auch wenn 3K das
Abschlusskennzeichen verspätet liefert. Der Mannschaftsstand bleibt zwischen
den Partien sichtbar. In den Tabellen öffnet die Mannschaft mit **LIVE** direkt
ihre laufende Begegnung.

Bei einem gewonnenen Leg oder einer gewonnenen Partie erscheint die Sieganimation
mit dem vorhandenen Spielerbild, im Doppel mit beiden vorhandenen Bildern.
Fehlende oder nicht eindeutig zuordenbare Fotos werden weggelassen. Unter
**Mein Darts → Darstellung & Lieblingsteam → Sieganimationen im TV-Modus** lässt
sich die Anzeige ein- und ausschalten. Die normale Web-App-Übersicht enthält
eine kleine, beim Scrollen sichtbare Live-Leiste mit den Restpunkten der Legs.
Sie ist innerhalb der Web-App sichtbar, nicht in der Handy-Systemstatusleiste.

Restpunkte, geworfene Punkte und Darts beziehen sich in der Liga-Liveansicht auf
das aktuelle 501-Leg. Der separat beschriftete **AVG (Partie)** bleibt der Average
der gesamten Partie. Die Anzeige von Punkten und Darts früherer Legs entfällt.

## Vereinstraining

Die App zeigt unter Training alle laufenden Boards mit Restpunkten, Legs und Average. Gruppen, Ergebnisse, Teilnehmer und Bestleistungen bleiben in derselben Oberfläche. Die öffentliche 3K-Verbindung dient als Ausweichweg; gespeicherte Daten werden bei einer Unterbrechung als letzter Stand angezeigt.

Unter Mein Darts → Teams, Spieler & Ereignisse kann Vereinstraining zusätzlich eingeschaltet werden. Die Ereignisauswahl gilt auch fürs Training. Ohne einzelne Spieler folgt man allen Trainingsspielern; mit einer Spielerauswahl nur diesen. Bestehende Abos werden nicht automatisch erweitert. Ein Tipp auf eine Trainingsmeldung öffnet das passende Training.

Der Server prüft die unabhängige 3K-Live-Quelle alle zehn Sekunden. Der erste Stand sowie ältere Stände nach längeren Unterbrechungen bilden nur eine Ausgangsbasis und erzeugen keine nachträglichen Meldungen. Versand und Geräteempfang sind getrennte Prüfungen; ein echter Geräteempfang muss vom Nutzer bestätigt werden.

Web-App: npm run build:web und npm run stage:web. Android: npm run build und die vorhandene Android-Konfiguration synchronisieren. Firebase-Serverdateien gehören ausschließlich auf den Server.
