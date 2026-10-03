# Barver Darts – native App-Grundlage (0.1)

## Stand

Separate, lokal gebündelte Capacitor-Oberfläche für Android und iOS. Kein eingebetteter
Verwaltungszugang und keine administrative API. Die produktive Website bleibt unverändert.
**Noch keine installierbare, signierte APK/IPA, keine Store-Veröffentlichung und keine native Pushzustellung.**

- Startseite, Spiele, vier Mannschaften, Kader und persönliche Spielerangaben.
- Alle gleichzeitig aktiven Boards mit Leg-Punkten, Spielbericht mit Averages.
- Lieblingsmannschaft, vorbereitete Ereignisauswahl, öffentliche Highlights.
- Lokaler letzter bekannter Datenstand; automatische erneute Versuche im Vordergrund.
- Öffentliche Daten ausschließlich vom bestehenden ClubIQ-Server. Kein direkter 3K-Abruf pro Gerät.
- Eigene lokale Oberfläche statt beliebiger fremder Webseiten in einer privilegierten WebView.
- Native Push-Empfangs-/Registrierungshooks vorbereitet, aber bewusst nicht aktiviert.

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
App-ID vor Anmeldung in den Stores verbindlich festlegen: aktuell `party.clubiq.barverdarts`.
Die erzeugten nativen Projekte sind vorläufig lokale Artefakte. Sobald native Anpassungen verbindlich
sind, diese ohne Signaturdateien/Firebase-Dateien gezielt ins Repository übernehmen.

## Nächster Schritt: echte native Pushzustellung

1. Entwicklerkonten durch den Verein anlegen; Identität, Gebühren und rechtliche Angaben selbst bestätigen.
2. Android: Firebase-Projekt/App, `google-services.json`, serverseitige FCM-v1-Zugangsdaten.
3. iOS: Push-Capability, APNs-Schlüssel/Team-/Key-ID, Signing und AppDelegate-Callbacks gemäß Capacitor.
4. Server: eigene native Geräte-Abos mit widerrufbarer Geräteauthentifizierung, APNs-/FCM-Sender,
   persistente Versandwarteschlange, kurze Gültigkeit, Wiederholungsversuche, Deduplizierung,
   Entfernung ungültiger Tokens, Team-/Spieler-/Ereignisfilter und sichere Testmeldung.
   Bestehende Erkennung aus `darts_live`/`darts_push` wiederverwenden; Web-Push nicht ersetzen.
5. Den vorbereiteten Client-Transport anschließen und Abowünsche an den Server synchronisieren.
   Keine Freigabeanzeige nur aufgrund einer Betriebssystem-Erlaubnis.
6. Auf echten Geräten bei geöffneter, geschlossener und gesperrter App testen; Datenschutzangaben
   und Store-Unterlagen vervollständigen. Versandannahme ist keine garantierte Anzeige am Gerät.

`createNativePush` bleibt ohne konfigurierten Transport gesperrt. Es werden aktuell keine
Gerätetokens abgefragt oder übertragen. Die gespeicherte Ereignisauswahl ist noch kein Server-Abo.
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
Turnier und rechtliche Seiten öffnen gezielt im Systembrowser. Noch keine Spieler-Abos,
kein echter Zustellverlauf, keine native Offline-/Hintergrund-Pushprüfung. Die vorbereitete
App ist eine erste Grundlage und ersetzt nicht die vollständigere Website.

Offizielle Grundlagen:
- https://capacitorjs.com/docs/apis/push-notifications
- https://capacitorjs.com/docs/getting-started/environment-setup
- https://developer.apple.com/app-store/review/guidelines/#minimum-functionality
