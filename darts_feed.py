from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock

import requests


API = "https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend/event"
LEAGUES = (
    {"event": 1445, "phase": 2139, "teams": {174110, 174111, 174112}},
    {"event": 1460, "phase": 2154, "teams": {174266}},
)
CACHE_SECONDS = 45
_cache: dict | None = None
_cache_time = 0.0
_lock = Lock()


class DartsFeedUnavailable(RuntimeError):
    pass


def _iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _participant(match: dict, side: str) -> tuple[int | None, str]:
    participant = match.get(f"participant{side}") or {}
    return participant.get("id"), str(participant.get("displayName") or "Unbekannt")


def _ticker_item(match: dict, phase: int, round_id: int) -> dict:
    home_id, home = _participant(match, "Home")
    away_id, away = _participant(match, "Guest")
    home_score, away_score = match.get("setsHome"), match.get("setsAway")
    status = str(match.get("statusCd") or "OPEN").upper()
    played = _iso(match.get("endDate") or match.get("lastUpdate"))
    planned = _iso(match.get("datePlanned"))
    if status == "FINISH" and isinstance(home_score, int) and isinstance(away_score, int):
        if home_score == away_score:
            text = f"{home} und {away} trennen sich {home_score}:{away_score}"
        else:
            winner, loser = (home, away) if home_score > away_score else (away, home)
            winner_score, loser_score = (home_score, away_score) if home_score > away_score else (away_score, home_score)
            text = f"{winner} gewinnt {winner_score}:{loser_score} gegen {loser}"
        kind, sort_time = "final", played or planned
    elif isinstance(home_score, int) and isinstance(away_score, int):
        text = f"Zwischenstand: {home} {home_score}:{away_score} {away}"
        kind, sort_time = "live", played or planned
    else:
        text = f"{home} gegen {away}"
        kind, sort_time = "upcoming", planned
    match_id = int(match.get("id") or 0)
    event = int(match.get("eventId") or 0)
    return {
        "id": match_id,
        "kind": kind,
        "text": text,
        "home": home,
        "away": away,
        "homeTeamId": home_id,
        "awayTeamId": away_id,
        "score": f"{home_score}:{away_score}" if isinstance(home_score, int) and isinstance(away_score, int) else None,
        "plannedAt": planned.isoformat() if planned else None,
        "updatedAt": sort_time.isoformat() if sort_time else None,
        "url": f"https://portal.3k-darts.com/frontend/events/10/event/{event}/phase/{phase}/group/{round_id}?matchId={match_id}",
    }


def _relevant_rounds(rounds: list[dict], now: datetime) -> list[dict]:
    dated = [(item, _iso(item.get("dateFrom"))) for item in rounds]
    dated = [(item, date) for item, date in dated if date]
    before = [pair for pair in dated if pair[1] <= now]
    after = [pair for pair in dated if pair[1] >= now]
    chosen = []
    if before:
        chosen.append(max(before, key=lambda pair: pair[1])[0])
    if after:
        candidate = min(after, key=lambda pair: pair[1])[0]
        if not chosen or candidate.get("id") != chosen[0].get("id"):
            chosen.append(candidate)
    return chosen or [item for item, _ in dated[:1]]


def _load(now: datetime) -> dict:
    session = requests.Session()
    session.headers["User-Agent"] = "ClubIQ-Darts/1.0 (+https://barverdarts.clubiq.party/)"
    items: dict[int, dict] = {}
    for league in LEAGUES:
        phase_url = f"{API}/{league['event']}/phase/{league['phase']}"
        phase_response = session.get(phase_url, timeout=(3, 8))
        phase_response.raise_for_status()
        for round_info in _relevant_rounds(phase_response.json().get("rounds") or [], now):
            round_id = int(round_info["id"])
            round_url = f"{phase_url}/round/{round_id}"
            round_response = session.get(round_url, timeout=(3, 8))
            round_response.raise_for_status()
            for match in round_response.json().get("matches") or []:
                home_id, _ = _participant(match, "Home")
                away_id, _ = _participant(match, "Guest")
                if (home_id in league["teams"] or away_id in league["teams"]) and home_id and away_id and not match.get("byeHome") and not match.get("byeAway"):
                    item = _ticker_item(match, league["phase"], round_id)
                    items[item["id"]] = item
    values = list(items.values())
    live = sorted((item for item in values if item["kind"] == "live"), key=lambda item: item["updatedAt"] or "", reverse=True)
    upcoming = sorted((item for item in values if item["kind"] == "upcoming"), key=lambda item: item["plannedAt"] or "")
    finals = sorted((item for item in values if item["kind"] == "final"), key=lambda item: item["updatedAt"] or "", reverse=True)
    ordered = live + upcoming + finals
    return {"available": True, "stale": False, "updatedAt": now.isoformat(), "items": ordered[:12]}


def get_darts_feed(now: datetime | None = None) -> dict:
    global _cache, _cache_time
    now = now or datetime.now(timezone.utc)
    timestamp = now.timestamp()
    with _lock:
        if _cache and timestamp - _cache_time < CACHE_SECONDS:
            return _cache
        try:
            _cache = _load(now)
            _cache_time = timestamp
            return _cache
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            if _cache:
                return {**_cache, "stale": True}
            raise DartsFeedUnavailable("3K-Ergebnisse sind gerade nicht erreichbar.") from exc
