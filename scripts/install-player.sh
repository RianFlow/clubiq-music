#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo starten: sudo ./scripts/install-player.sh" >&2
  exit 1
fi

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$project_dir/.env"
[ -f "$env_file" ] || { echo ".env fehlt in $project_dir" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends bluez bluez-alsa-utils libasound2-plugin-bluez mpv yt-dlp openssl
systemctl enable --now bluetooth bluealsa

install -d -m 0700 /etc/clubiq-music
install -d -m 0755 /var/lib/clubiq-music
install -d -m 0755 /run/clubiq-music

token="$(sed -n 's/^PLAYER_AGENT_TOKEN=//p' "$env_file" | tail -n 1)"
if [ -z "$token" ]; then
  token="$(openssl rand -hex 32)"
  if grep -q '^PLAYER_AGENT_TOKEN=' "$env_file"; then
    sed -i "s/^PLAYER_AGENT_TOKEN=.*/PLAYER_AGENT_TOKEN=$token/" "$env_file"
  else
    printf '\nPLAYER_AGENT_TOKEN=%s\n' "$token" >> "$env_file"
  fi
fi
printf '%s' "$token" > /etc/clubiq-music/player-token
chmod 0600 /etc/clubiq-music/player-token

install -m 0755 "$project_dir/player_agent.py" /usr/local/lib/clubiq-music-player.py
cat > /etc/systemd/system/clubiq-music-player.service <<'EOF'
[Unit]
Description=ClubIQ Music Bluetooth Player
After=bluetooth.service bluealsa.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/lib/clubiq-music-player.py
Restart=always
RestartSec=3
Environment=PLAYER_AGENT_SOCKET=/run/clubiq-music/player.sock
Environment=PLAYER_AGENT_TOKEN_FILE=/etc/clubiq-music/player-token
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/run/clubiq-music /var/lib/clubiq-music

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable clubiq-music-player
# Auch bei einer erneuten Installation muss der laufende Dienst den neuen
# Programmstand und das aktuelle Token sicher übernehmen.
systemctl restart clubiq-music-player
cd "$project_dir"
docker compose up -d --force-recreate web
echo "ClubIQ Player ist installiert. Zustand: systemctl status clubiq-music-player"
