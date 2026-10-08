"""Public, presentation-only feed for Barver's confirmed DBD ranking series."""
from datetime import datetime, timezone
from math import isfinite
from threading import Lock

import requests
from darts_feed import DartsFeedUnavailable, _public_get
from darts_collector import collected_snapshot

API = "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend"
SOURCE = "https://portal.3k-darts.com/frontend/events/5/ranking/1931/series/1282/list"
_cache = None
_lock = Lock()


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value) else None


def _sanitize(payload, now):
    series = payload.get("tournamentSeries") or {}
    if series.get("id") != 1282:
        raise ValueError("Unerwartete 3K-Turnierserie.")
    events = []
    for event in payload.get("events") or []:
        event_id = event.get("id")
        if not isinstance(event_id, int) or event_id <= 0:
            continue
        events.append({"id": event_id, "name": str(event.get("name") or "Turnierrunde")[:180],
                       "start": event.get("datetime"), "city": str(event.get("locationCity") or "")[:120],
                       "sourceUrl": f"https://portal.3k-darts.com/frontend/events/5/event/{event_id}/participants"})
    event_ids = {event["id"] for event in events}
    rows = []
    for row in payload.get("ranking") or []:
        name = str(row.get("displayName") or "").strip()
        if not name:
            continue
        rounds = [{"id": event.get("id"), "points": _number(event.get("pointsTotal")),
                   "rated": not bool(event.get("rankingNotRated"))}
                  for event in row.get("eventList") or [] if event.get("id") in event_ids]
        rows.append({"rank": _number(row.get("placement")), "name": name[:120],
                     "points": _number(row.get("pointsTotal")), "appearances": _number(row.get("countEvents")),
                     "average": _number(row.get("pointsAverageEvent")), "rounds": rounds})
    return {"available": True, "stale": False, "updatedAt": now.isoformat(),
            "name": str(series.get("name") or "DBD Rangliste 2026")[:180],
            "sourceUrl": SOURCE, "events": events, "rows": rows}


def get_darts_ranking(now=None):
    global _cache
    now = now or datetime.now(timezone.utc)
    collected = collected_snapshot("ranking", 660, now)
    if collected:
        return collected
    with _lock:
        if _cache and now.timestamp() - _cache[0] < 600:
            return _cache[1]
        try:
            result = _sanitize(_public_get(f"{API}/ranking?mandantKey=1931&tournamentSeriesId=1282&withEventDetails=1"), now)
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            if _cache:
                return {**_cache[1], "stale": True}
            raise DartsFeedUnavailable("Die DBD-Rangliste konnte gerade nicht von 3K geladen werden.") from exc
        _cache = (now.timestamp(), result)
        return result
