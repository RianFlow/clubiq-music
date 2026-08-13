#!/bin/bash
set -e
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip mpv bluez
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
chmod +x cloudflared
mkdir -p pics