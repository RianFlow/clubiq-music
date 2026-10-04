# Android-Push für Barver Darts

## Aktueller Stand

Die App und der Server sind für Android-FCM vorbereitet. Echte Zustellung ist erst
nach Firebase-Einrichtung, erneutem APK-Bau, Serverinstallation und Gerätetest bestätigt.
Die bisher ausgegebene APK 0.1.0 hat noch keine nutzbare Push-Anbindung.
iOS/APNs ist in diesem Schritt nicht eingerichtet.

## Was du einmal einrichten musst

1. [Firebase-Konsole](https://console.firebase.google.com/) öffnen und ein Projekt für
   Barver Darts anlegen oder auswählen. Google Analytics ist hierfür nicht nötig.
   Bedingungen und Kontoeinstellungen selbst prüfen; kein Store-Konto anlegen.
2. Eine Android-App hinzufügen. Paketname exakt: `party.clubiq.barverdarts`.
3. `google-services.json` herunterladen und lokal im Projekt unter
   `mobile/android/app/google-services.json` ablegen. Dies ist die App-Konfiguration,
   **kein privater Server-Schlüssel**. Danach bauen wir die APK neu.
4. Die Server-Zugangsdaten getrennt einrichten. Ein Dienstkonto mit der für FCM nötigen
   Berechtigung verwenden. Seine private JSON-Datei ausschließlich auf dem Server in
   einem geschützten Verzeichnis speichern, niemals im Chat oder in GitHub.
5. Serverdatei schreibgeschützt in den Web-Container einbinden und
   `DARTS_FCM_CREDENTIALS` auf den **Pfad im Container** setzen. Der unprivilegierte
   Containerbenutzer (UID 10001) muss die Datei lesen können. Ohne diesen Schritt
   bleibt die Aktivierung gesperrt. Die Datei darf nicht in das Docker-Image kopiert werden.
6. Backend bauen/installieren und prüfen: `/api/v1/darts/push/native/config` muss
   `available: true` melden. Das zeigt die verfügbare Konfiguration, noch keine
   erfolgreiche Zustellung.

Die App-Konfiguration wird vom bestehenden Google-Services-Gradle-Plugin verarbeitet.
`npm run build`, `npx cap sync android`, `npm run android:prepare`, anschließend Gradle-Bau.
Vorhandenen lokalen Test-Signaturschlüssel erhalten, damit die APK als Update installierbar bleibt.
Privaten Server-Schlüssel **nicht** unter `mobile/` ablegen.

## Bedienung und Test

In der Android-App unter **Mein Darts** „Pushmeldungen aktivieren“ wählen und die
Android-Erlaubnis bestätigen. Mannschaften und Ereignisse wählen. Einzelne Spieler
werden zusätzlich zu Mannschaften abonniert; für nur einen Spieler alle Mannschaften abwählen.
Eine Betriebssystem-Erlaubnis allein gilt nicht als Serverregistrierung.

„Testnachricht senden“ verschickt nur an dieses angemeldete Gerät. Test zuerst mit
geöffneter, danach mit geschlossener App und gesperrtem Handy. Das Antippen einer
Sportmeldung soll direkt die betreffende Begegnung öffnen. Tests im Abstand von
mindestens einer Minute. Bei App-„Stopp erzwingen“ kann Android Meldungen blockieren;
App danach wieder öffnen. Für FCM muss das Android-Gerät Google Play-Dienste besitzen;
ein Login im Google Play Store ist zur APK-Installation nicht nötig.

Empfangene oder angetippte Meldungen stehen lokal unter „In der App empfangen“.
Das ist kein vollständiger Zustellverlauf: ungeöffnete Hintergrundmeldungen können
Android anzeigen, ohne dass die App sie bereits in ihren lokalen Verlauf aufgenommen hat.

## Schutz und Zuverlässigkeit

- Eigener zufälliger Geräteschlüssel für Anmeldung, Änderungen, Test und Abmeldung;
  auf dem Server nur dessen Hash. Kein Verwaltungszugang in der App.
- Teams, Spieler und 180er/High Finishes/Legs/Partien/Gesamtergebnisse frei wählbar.
- Bestehende Sportereignisse und Deduplizierung bleiben Grundlage; kein Versand alter
  Saisonereignisse an neu angemeldete Geräte.
- Persistente Warteschlange mit kurzen Gültigkeitszeiten und begrenzten Wiederholungen.
  Ungültige FCM-Tokens werden deaktiviert. Serverannahme ist keine garantierte Handy-Anzeige.
- Benachrichtigungsinhalt kann auf dem Sperrbildschirm sichtbar sein. Vor Veröffentlichung
  die Datenschutzerklärung um FCM/Google, Gerätetoken und gewählte Abos ergänzen lassen.

## Offizielle Grundlagen

- [Firebase-Android-Einrichtung](https://firebase.google.com/docs/android/setup)
- [FCM-Serverversand](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)
- [Capacitor-Push-Plugin](https://capacitorjs.com/docs/apis/push-notifications)
