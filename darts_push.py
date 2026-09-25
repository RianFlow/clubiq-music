from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlparse


PUSH_HOSTS = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
)
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
TEAM_PATTERN = re.compile(r"SV Barver Darts ([A-D])")


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


def _event_identity(league: str, event: dict) -> tuple[str, str] | None:
    event_type = str(event.get("type") or "")
    match_id = event.get("matchId")
    if event_type not in {"180", "high_finish", "leg", "game", "match"} or not isinstance(match_id, int):
        return None
    if event_type in {"180", "high_finish"}:
        identity = f"{event.get('performanceId') or event.get('player')}|{event.get('value')}|{event.get('count')}"
    elif event_type == "leg":
        identity = f"{event.get('gameId')}|{event.get('winnerSide')}|{event.get('legCount')}"
    elif event_type == "game":
        identity = f"{event.get('gameId')}|{event.get('homeLegs')}|{event.get('awayLegs')}"
    else:
        identity = str(event.get("score") or event.get("text") or "final")
    return event_type, f"{league}|{match_id}|{event_type}|{identity}"


def barver_push_event(league: str, event: dict) -> dict | None:
    identity = _event_identity(league, event)
    team_name = str(event.get("team") or "")
    team_match = TEAM_PATTERN.fullmatch(team_name)
    if not identity or not team_match:
        return None
    event_type, fingerprint_source = identity
    match_id = event["matchId"]
    player = str(event.get("player") or team_name).strip()[:100]
    count = event.get("count") if isinstance(event.get("count"), int) and event.get("count") > 0 else 1
    if event_type == "180":
        title = f"🎯 180! {player}"
        body = team_name + (f" · bereits {count}× 180" if count > 1 else "")
        tag = f"clubiq-180-{match_id}-{player.casefold().replace(' ', '-')}"
    elif event_type == "high_finish":
        value = event.get("value")
        if not isinstance(value, int) or not 2 <= value <= 170:
            return None
        title = f"🔥 High Finish {value}"
        body = f"{player} · {team_name}"
        tag = f"clubiq-high-finish-{match_id}-{player.casefold().replace(' ', '-')}"
    elif event_type == "leg":
        title = f"🎯 {event.get('title') or f'Leg für {player}'}"
        body = f"{team_name} · {str(event.get('text') or '').strip()}"[:220]
        tag = f"clubiq-leg-{event.get('gameId') or match_id}"
    elif event_type == "game":
        result = event.get("barverWon")
        title = "✅ Partie gewonnen" if result is True else "Partie beendet" if result is None else "Partie verloren"
        body = f"{team_name} · {str(event.get('text') or '').strip()}"[:220]
        tag = f"clubiq-game-{event.get('gameId') or match_id}"
    else:
        title = f"🏁 Endstand Barver {team_match.group(1)}"
        body = str(event.get("text") or "Mannschaftsspiel beendet")[:220]
        tag = f"clubiq-match-{match_id}"
    return {
        "event_id": hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest(),
        "event_type": event_type,
        "match_id": match_id,
        "team": team_match.group(1),
        "player": player,
        "count": count,
        "title": title,
        "body": body,
        "url": "https://barverdarts.clubiq.party/",
        "tag": tag,
    }


def barver_180_event(league: str, event: dict) -> dict | None:
    normalized = barver_push_event(league, event)
    return normalized if normalized and normalized["event_type"] == "180" else None


def _recent(value: str | None, now: datetime, seconds: int = 300) -> bool:
    if not value:
        return False
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return 0 <= (now - timestamp.astimezone(timezone.utc)).total_seconds() <= seconds
    except (TypeError, ValueError):
        return False


def barver_push_candidates(league: str, center: dict, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    matches = {
        match.get("id"): match
        for match in center.get("barverMatches") or []
        if isinstance(match.get("id"), int)
    }
    candidates = []
    for raw_event in center.get("pushEvents") or center.get("events") or []:
        event = barver_push_event(league, raw_event)
        if not event:
            continue
        match = matches.get(event["match_id"]) or {}
        deliver = match.get("kind") == "live"
        if event["event_type"] in {"180", "high_finish", "game", "match"} and match.get("kind") == "final":
            deliver = match.get("kind") == "final" and _recent(match.get("updatedAt"), now)
        candidates.append({**event, "deliver": deliver})
    return candidates


def barver_180_candidates(league: str, center: dict) -> list[dict]:
    return [
        {**event, "live": event["deliver"]}
        for event in barver_push_candidates(league, center)
        if event["event_type"] == "180"
    ]


def push_payload(event: dict) -> str:
    return json.dumps(
        {key: event[key] for key in ("title", "body", "url", "tag")},
        ensure_ascii=False,
        separators=(",", ":"),
    )
