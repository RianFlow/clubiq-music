"""Public DBD ranking, official series calendar and clearly tentative club dates."""
from datetime import date, datetime, timezone
from math import isfinite
from pathlib import Path
from threading import Lock
from zoneinfo import ZoneInfo
import json

import requests
from darts_feed import DartsFeedUnavailable, _public_get
from darts_collector import collected_snapshot

API = "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend"
SOURCE = "https://portal.3k-darts.com/frontend/events/5/ranking/1931/series/1282/list"
_cache = None
_lock = Lock()
PLANS = json.loads((Path(__file__).parent / "static/darts-ranking-plans.json").read_text(encoding="utf-8"))["events"]


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value) else None


def _event_day(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(ZoneInfo("Europe/Berlin")).date() if parsed.tzinfo else parsed.date()
    except (ValueError, TypeError):
        return None


def _planned_events(events, now):
    today = now.astimezone(ZoneInfo("Europe/Berlin")).date()
    published = {(_event_day(event["start"]), event["city"].casefold()) for event in events}
    return [{**plan, "confirmed": False} for plan in PLANS
            if date.fromisoformat(plan["date"]) >= today
            and (date.fromisoformat(plan["date"]), plan["city"].casefold()) not in published]


def _sanitize(payload, now, calendar_events=None):
    series = payload.get("tournamentSeries") or {}
    if series.get("id") != 1282:
        raise ValueError("Unerwartete 3K-Turnierserie.")
    rated_ids = {event.get("id") for event in payload.get("events") or []}
    merged = {event.get("id"): event for event in payload.get("events") or []}
    # The series calendar includes rounds that do not have ranking points yet.
    merged.update({event.get("id"): event for event in calendar_events or []})
    events = []
    for event in merged.values():
        event_id = event.get("id")
        if not isinstance(event_id, int) or isinstance(event_id, bool) or not 0 < event_id <= 10000000 or event.get("dbId", 5) != 5:
            continue
        events.append({"id": event_id, "name": str(event.get("name") or "Turnierrunde")[:180],
                       "start": event.get("datetime"), "city": str(event.get("locationCity") or "")[:120],
                       "rated": event_id in rated_ids,
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
            "sourceUrl": SOURCE, "events": events, "rows": rows,
            "plannedEvents": _planned_events(events, now), "calendarAvailable": calendar_events is not None}


def _load(now):
    payload = _public_get(f"{API}/ranking?mandantKey=1931&tournamentSeriesId=1282&withEventDetails=1")
    if not isinstance(payload, dict) or (payload.get("tournamentSeries") or {}).get("id") != 1282:
        raise ValueError("Unerwartete 3K-Turnierserie.")
    calendar = _public_get(f"{API}/tournamentseries/1931?tournamentSeriesId=1282")
    if not isinstance(calendar, dict) or calendar.get("mandantKey") != 1931 or not isinstance(calendar.get("tournamentSeries"), list):
        raise ValueError("Ungültiger 3K-Serienkalender.")
    series = [item for item in calendar["tournamentSeries"] if isinstance(item, dict) and item.get("id") == 1282]
    if len(series) != 1:
        raise ValueError("Die DBD-Serie fehlt im 3K-Kalender.")
    events = series[0].get("eventList")
    if events is None:
        events = _public_get(f"{API}/tournamentseries/1282/eventlist")
    if (not isinstance(events, list) or not 0 < len(events) <= 128
        or any(not isinstance(event, dict) or not isinstance(event.get("id"), int)
               or isinstance(event["id"], bool) or not 0 < event["id"] <= 10000000
               or event.get("dbId") != 5 for event in events)):
        raise ValueError("Unvollständiger 3K-Serienkalender.")
    return _sanitize(payload, now, events)


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
            result = _load(now)
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            if _cache:
                return {**_cache[1], "stale": True}
            raise DartsFeedUnavailable("Die DBD-Rangliste konnte gerade nicht von 3K geladen werden.") from exc
        _cache = (now.timestamp(), result)
        return result
