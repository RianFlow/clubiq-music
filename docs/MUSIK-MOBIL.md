# Musik auf Handy und Tablet

Die Musik-App nutzt auf allen Geräten dieselben Daten und Berechtigungen. Es ist keine zweite Installation und kein separates Konto nötig. Wiedergabe und Bluetooth-Verbindung bleiben auf dem Raspberry.

## Handy

- Die vier Bereiche **Abstimmen**, **Playlists**, **Player** und **Meine Musik** bleiben am unteren Rand erreichbar.
- Beim Bereichswechsel beginnt die Ansicht oben; eine weit heruntergescrollte Songliste führt nicht mehr zu einem leeren Einstieg im nächsten Bereich.
- Der Mini-Player steht oberhalb der Navigation. Nur freigegebene DJs sehen Start/Pause. „Zum Player“ öffnet die vollständige Steuerung.
- Größere Punktetasten und mehrzeilige Titel erleichtern die Abstimmung. Hörprobe und Favoriten bleiben direkt beim Song.
- Dialoge sind auf kleinen Bildschirmen scrollbar. Eingabefelder verwenden mindestens 16 Pixel Schriftgröße, Touch-Schaltflächen mindestens 44 Pixel.

## Tablet

Auf breiten Tablets stehen Player und Warteschlange nebeneinander. Auf schmaleren Tablets werden sie untereinander angezeigt. Die Navigation bleibt oben. Hoch- und Querformat sind möglich.

## Prüfung

`tests/test_navigation_browser.cjs` prüft mit lokalen Beispieldaten die Breiten 320, 390, 768, 844 und 1024 Pixel, niedrige Dialog-Ansichten, lange Namen, Favoriten, Touch-Navigation, Rollenrechte, überlagerungsfreie Navigation/Mini-Player und unveränderte Wiedergabe beim reinen Navigieren. Kein Zugriff auf Vereinsdaten oder die laufende Wiedergabe.

Ein echter iPhone-/Android-/Tablet-Test (insbesondere Bildschirmtastatur und Geräteaussparungen) bleibt als Praxistest sinnvoll; Browser-Viewport-Tests ersetzen diesen nicht vollständig.
