# Separater Ausgang für den Darts-Datenhelfer

Der Container verwendet einen eigenen WARP-WireGuard-Zugang und den kleinen
Userspace-Client `wireproxy`. Er verändert keine Host-Routen und benötigt weder
TUN-Gerät, `NET_ADMIN`, privilegierten Modus noch DBus. Er ist nicht der offizielle
Cloudflare-Linux-Client. Die Cloudflare-Voraussetzung von drei vCPU für diesen
offiziellen Client ist daher kein Nachweis für unsere andere Runtime.

## Versionen und Herkunft

Am 08.10.2026 mit den öffentlichen GitHub-Release-Metadaten geprüft:

| Werkzeug | Feste Version | Linux amd64 SHA-256 |
|---|---|---|
| wgcf | 2.3.0 | `01614e38c0eb5f3405232e71cfaf02d64d4809e4988ad8f5a8071af16d193405` |
| wireproxy | 1.1.3 | `e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c` (tar.gz) |

Der Docker-Build prüft beide Hashes. Das Python-Basisimage ist ebenfalls auf
Tag und Digest festgelegt. Diese Dateihashes bestätigen die Identität der
ausgewählten Releases; sie sind kein unabhängiges Sicherheits-Audit.

`wgcf` ist ausdrücklich inoffiziell. Es erstellt ausschließlich eine eigene
kostenlose WARP-Geräteregistrierung; WARP+-Schlüssel oder fremde Profile werden
nicht verwendet. Der Zugang bleibt von Cloudflares nicht zugesicherter
Kompatibilität mit diesem Client abhängig.

## Betrieb

- `Dockerfile.darts-egress` bauen, auf dem vorhandenen VPS `linux/amd64`.
- Privates Named Volume ausschließlich auf `/state`; Benutzer `10002:10002`.
  Ein neues Docker-Volume übernimmt den vorbereiteten Besitzer aus dem Image.
  Bereits vorhandene Volumes müssen diesem Benutzer gehören.
- Nur für die erste Registrierung `DARTS_WARP_ACCEPT_TOS=1` setzen, nachdem die
  Nutzung unter Cloudflares Bedingungen autorisiert wurde. Ohne Profil oder
  diese Freigabe stoppt der Container. Bei jedem späteren Start werden die
  vorhandenen Registrierung und das Profil wiederverwendet.
- HTTP-CONNECT-Port `40001` nur im dedizierten Compose-Netzwerk für den
  Website und Datenhelfer verwenden. **Keine `ports:`-Veröffentlichung**, kein Host-Netzwerk,
  kein gemeinsam verwendetes allgemeines Proxy-Netzwerk. Der Helfer nutzt
  `DARTS_3K_HTTPS_PROXY=http://darts-egress:40001`; ausschließlich die drei
  freigegebenen 3K-Hosts erhalten diesen Transport. Globale `HTTPS_PROXY`-Werte
  werden nicht gesetzt. Der private Proxy bietet keine anwendungseigene Authentifizierung.
- Runtime kann mit `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
  schreibgeschütztem Root-Dateisystem und `/tmp` als tmpfs laufen. `/state` bleibt
  beschreibbar. `init: true`, `restart: unless-stopped`, ungefähr 256 MiB RAM
  zunächst vorsehen und den tatsächlichen Speicher/CPU-Verbrauch messen.
- Ein Supervisor prüft jede Minute über den Proxy die Cloudflare-Trace mit
  `warp=on/plus` und das bekannte öffentliche 3K-Training 32751, inklusive TLS-
  und Event-Kennung. Es werden keine Antworten oder IPs protokolliert.
  Nach drei aufeinanderfolgenden Verbindungsfehlern wird derselbe Tunnel mit
  30 Sekunden Pause neu gestartet. HTTP 403/429, Zertifikatsfehler oder unerwartete
  Inhalte lösen keine solche Wiederverbindung aus. Dafür ist die Ursache zu klären.
- Der Docker-Healthcheck liest dieses Prüfergebnis mit maximal zwei Minuten
  Alter. Docker allein startet `unhealthy`-Container nicht automatisch neu;
  hierfür gibt es den Supervisor. Stirbt dieser selbst, greift die Restart-Policy.
- `/state/wgcf-account.toml`, `wgcf-profile.conf` und `wireproxy.conf` sind privat,
  Rechte 0600, Volume-Verzeichnis 0700. Keine dieser Dateien in Git, Chat,
  Support-Protokolle oder normale Download-Artefakte kopieren. Private Backups
  dürfen nur verschlüsselt und zugriffsbeschränkt erfolgen.

## Erforderlicher Nachweis vor Live-Aktivierung

Diese Implementierung ist zunächst ein vorbereiteter Transport. Der bisherige
erfolgreiche offizielle WARP-Test mit MASQUE beweist keinen funktionierenden
WireGuard-UDP-Tunnel. Zuerst direkt auf dem VPS prüfen: Cloudflare-Trace und beide
3K-Backends über diesen Container, tatsächlicher kompletter Helfer-Durchlauf,
Container-Neustart ohne neue Registrierung, unveränderte Host-Routen und keine
öffentlich erreichbaren Proxy-Ports. Werden UDP/Handshake oder die inoffizielle
Registrierung blockiert, nicht automatisch neue Identitäten, Ports oder IPs
durchprobieren. Als geprüften Fallback den offiziellen WARP-Proxy mit gemessenen
Ressourcen verwenden und den Betrieb auf zwei vCPU ausdrücklich als empirisch
getestet, nicht als Erfüllung der dokumentierten Drei-vCPU-Mindestgröße beschreiben.

## Primärquellen

- [wgcf-Projekt](https://github.com/ViRb3/wgcf),
  [Registrierung](https://github.com/ViRb3/wgcf/blob/v2.3.0/cmd/register/register.go),
  [generiertes Profil](https://github.com/ViRb3/wgcf/blob/v2.3.0/wireguard/profile.go)
- [wireproxy 1.1.3](https://github.com/windtf/wireproxy/tree/v1.1.3),
  [HTTP-CONNECT und Userspace-Konfiguration](https://github.com/windtf/wireproxy/blob/v1.1.3/README.md)
- [Cloudflare-Protokolle](https://developers.cloudflare.com/warp-client/get-started/linux/),
  [offizielle Client-Anforderungen](https://developers.cloudflare.com/warp-client/get-started/)
