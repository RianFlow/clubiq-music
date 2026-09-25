from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlparse


PUSH_HOSTS = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
)
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,256}$")


def valid_push_endpoint(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Ungültiger Push-Endpunkt.")
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Ungültiger Push-Endpunkt.") from exc
    hostname = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.fragment
        or not any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in PUSH_HOSTS)
    ):
        raise ValueError("Dieser Push-Dienst wird nicht unterstützt.")
    return value


def valid_push_key(value: str) -> str:
    if not isinstance(value, str) or not KEY_PATTERN.fullmatch(value):
        raise ValueError("Ungültiger Push-Schlüssel.")
    return value


def barver_180_event(league: str, event: dict) -> dict | None:
    if event.get("type") != "180" or not isinstance(event.get("matchId"), int):
        return None
    team_name = str(event.get("team") or "")
    team_match = re.fullmatch(r"SV Barver Darts ([A-D])", team_name)
    if not team_match:
        return None
    player = str(event.get("player") or "Spieler").strip()[:100]
    count = event.get("count") if isinstance(event.get("count"), int) and event.get("count") > 0 else 1
    fingerprint_source = f"{league}|{event['matchId']}|180|{player}|{team_name}|{count}"
    return {
        "event_id": hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest(),
        "match_id": event["matchId"],
        "team": team_match.group(1),
        "player": player,
        "count": count,
        "title": f"🎯 180! {player}",
        "body": f"{team_name}" + (f" · bereits {count}× 180" if count > 1 else ""),
        "url": "https://barverdarts.clubiq.party/",
        "tag": f"clubiq-180-{event['matchId']}-{player.casefold().replace(' ', '-')}",
    }


def push_payload(event: dict) -> str:
    return json.dumps(
        {key: event[key] for key in ("title", "body", "url", "tag")},
        ensure_ascii=False,
        separators=(",", ":"),
    )
