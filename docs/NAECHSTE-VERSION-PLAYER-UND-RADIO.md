# Player-Berechtigung und Internetradio

Diese Funktionen sind implementiert. Bestehende und neue Mitglieder besitzen
zunächst keine Player-Freigabe; ein Admin erteilt sie gezielt.

## Berechtigungen

- Abstimmen und Songvorschläge bleiben für alle angemeldeten, aktiven Mitglieder möglich.
- Player-Bedienung wird eine eigene Berechtigung `can_control_player` und ist standardmäßig aus.
- Admins können diese Berechtigung in der Mitgliederverwaltung einzeln erteilen und wieder entziehen.
- Admins behalten unabhängig davon vollständigen Zugriff.
- Nur Admins und freigeschaltete Player-Bediener dürfen:
  - Wiedergabe starten, pausieren und Titel überspringen
  - Lautstärke, Stummschaltung, Wiederholung und Zufallsmodus ändern
  - die Warteschlange erstellen oder verändern
  - Soundboard-Töne auslösen
  - zwischen Playlist und Internetradio wechseln
- Nicht freigeschaltete Mitglieder sehen Playerstatus und Warteschlange nur lesend.
- Die Party-Anzeige bleibt ohne Anmeldung erreichbar und vollständig schreibgeschützt.
- Jeder steuernde Vorgang wird weiterhin mit Mitglied, Zeitpunkt und Aktion protokolliert.
- Die Berechtigung wird bei jedem schreibenden API-Aufruf serverseitig geprüft; ausgeblendete Schaltflächen allein reichen nicht als Schutz.

## Internetradio

- Der Player erhält die getrennten Betriebsarten `Playlist` und `Internetradio`.
- Admins verwalten eine kuratierte Senderliste mit Name, Logo, Genre, Stream-URL, optionaler Ersatz-URL, Sortierung und Aktivstatus.
- Der laufende Betrieb hängt nicht von der Verfügbarkeit des externen Senderverzeichnisses ab.
- Freigeschaltete Player-Bediener dürfen ausschließlich aktivierte Sender starten und wechseln.
- Beim Radiostart wird die aktuelle Playlistposition gespeichert; beim Rückwechseln wird sie wiederhergestellt.
- Soundboard-Töne unterbrechen oder dämpfen Radio kurz und danach läuft der Sender weiter.
- Titel und Interpret werden angezeigt, wenn der Stream ICY-Metadaten liefert.
- Bei einem Streamfehler folgen Neuversuche und anschließend eine optionale Ersatz-URL.
- Ohne Internet zeigt ClubIQ einen klaren Offline-Zustand, ohne die lokale Anwendung zu blockieren.

## Oberfläche

- In der Mitgliederverwaltung erscheint ein eindeutiger Schalter `Player bedienen`.
- Der normale Player zeigt nicht berechtigten Mitgliedern den Hinweis `Nur Anzeige – keine Player-Freigabe`.
- Die separate DJ-Fernbedienung bleibt mit dem Verwaltungskennwort geschützt.
- In `Player & Box` werden Senderverwaltung und Berechtigungsstatus getrennt dargestellt.
- Die Party-Anzeige bleibt optisch unverändert und erhält bei Radiobetrieb Senderlogo, Sendername und verfügbare Titelinformationen.

## Technische Abnahmekriterien

- Direkte Aufrufe aller schreibenden Player-Endpunkte liefern ohne Berechtigung HTTP 403.
- Eine erteilte oder entzogene Berechtigung wirkt ohne erneute Registrierung und spätestens nach dem nächsten Statusabruf.
- Voting, Vorschläge, öffentliche Playeranzeige und Party-Anzeige funktionieren weiterhin ohne Player-Berechtigung.
- Playlist, Radio und Soundboard können sich nicht gleichzeitig als aktive Hauptquelle überlagern.
- Quellenwechsel, Raspberry-Neustart und kurzzeitiger Streamausfall verlieren die gespeicherte Playlist nicht.
