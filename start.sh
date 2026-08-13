#!/bin/bash
cd ~/clubiq_music_dev
cloudflared tunnel --url http://localhost:8000 > cloudflare.log 2>&1 &
sleep 5
# Telegram Benachrichtigung (falls gewünscht)
export $(grep -v '^#' .env | xargs)
URL=$(grep -o 'https://[-0-9a-z]*\.trycloudflare.com' cloudflare.log | tail -n 1)
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d "chat_id=$TELEGRAM_CHAT_ID" -d "text=Clubiq ist online: $URL"

while true; do
    uvicorn main:app --host 0.0.0.0 --port 8000 &
    SERVER_PID=$!
    wait $SERVER_PID
    sleep 3
done