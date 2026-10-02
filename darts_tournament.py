"""Public tournament feed, isolated from league monitoring and push subscriptions."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Lock
import time

import requests
from darts_live import normalize_rest

BASE = "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend/event/22536"
SOURCE = "https://portal.3k-darts.com/frontend/events/5/event/22536/participants"
LIVE = "https://live.3k-darts.com/dartsscorer-liveticker/api/v1"
_lock = Lock()
_cache = None
_attempt = 0.0


def _get(url):
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://portal.3k-darts.com/", "Origin": "https://portal.3k-darts.com", "Accept": "application/json"}, timeout=(3, 8))
    response.raise_for_status()
    response.encoding = "utf-8"
    return response.json()


def _number(value):
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 10000000 else None


def _text(value):
    return " ".join(str(value or "").split())[:160]


def match_model(raw):
    identifier = _number(raw.get("id"))
    if not identifier or raw.get("byeHome") or raw.get("byeAway"):
        return None
    status = str(raw.get("statusCd", ""))
    kind = "final" if status == "FINISH" else "live" if status in {"ACTIVE", "RUNNING", "STARTED"} or (raw.get("beginDate") and not raw.get("endDate")) else "upcoming"
    return {"id": identifier, "kind": kind, "board": _text(raw.get("board")),
            "home": _text((raw.get("participantHome") or {}).get("displayName")) or "Noch offen",
            "away": _text((raw.get("participantGuest") or {}).get("displayName")) or "Noch offen",
            "homeLegs": _number(raw.get("legsHome") if kind == "final" else raw.get("liveLegsHome")),
            "awayLegs": _number(raw.get("legsAway") if kind == "final" else raw.get("liveLegsAway")),
            "round": _text((raw.get("round") or {}).get("name")),
            "phase": _text((raw.get("phase") or {}).get("name")),
            "updatedAt": _text(raw.get("endDate") or raw.get("lastUpdate")), "live": None}


def _round(job):
    phase, round_id = job
    payload = _get(f"{BASE}/phase/{phase}/round/{round_id}")
    return [model for raw in payload.get("matches", []) if isinstance(raw, dict) and (model := match_model(raw))]


def _live(match):
    try:
        games = normalize_rest(_get(f"{LIVE}/match/5/0/{match['id']}"))
        match["live"] = next((game for game in games if game["active"] and not game["finished"]), None)
        if match["live"] and match["live"]["board"]:
            match["board"] = match["live"]["board"]
    except (requests.RequestException, ValueError, TypeError):
        pass  # Keep the official score; never invent leg points.
    return match


def _load():
    detail = _get(BASE)
    event = detail.get("event") or {}
    if event.get("id") != 22536 or event.get("dbId") != 5:
        raise ValueError("Unexpected tournament source")
    participants = _get(f"{BASE}/participant")
    # Deliberately exclude payment, registration and other personal metadata.
    players = [{"id": _number(item.get("id")), "name": _text(item.get("displayName")), "waiting": item.get("waitingList") is True}
               for item in participants if isinstance(item, dict)]
    jobs = []
    phases = detail.get("phases") or []
    for phase in phases:
        phase_id = _number(phase.get("id"))
        if phase_id:
            data = _get(f"{BASE}/phase/{phase_id}")
            jobs.extend((phase_id, round_id) for row in data.get("rounds", []) if (round_id := _number(row.get("id"))))
    rows = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for matches in pool.map(_round, jobs):
            rows.update({match["id"]: match for match in matches})
        live_matches = [match for match in rows.values() if match["kind"] == "live"]
        list(pool.map(_live, live_matches))
    return {"event": {"id": 22536, "name": _text(event.get("name")), "date": event.get("datetime"), "status": _text(event.get("statusCd"))},
            "participants": players, "matches": list(rows.values()), "source": SOURCE,
            "updatedAt": datetime.now(timezone.utc).isoformat(), "stale": False,
            "scheduleReady": bool(jobs), "livePointsAvailable": any(match["live"] for match in live_matches)}


def get_tournament():
    global _cache, _attempt
    with _lock:
        if _cache is not None and time.monotonic() - _attempt < 15:
            return _cache
        if time.monotonic() - _attempt < 15:
            raise RuntimeError("Turnierdaten vorübergehend nicht erreichbar")
        _attempt = time.monotonic()
        try:
            _cache = _load()
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            if _cache is None:
                raise RuntimeError("Turnierdaten vorübergehend nicht erreichbar") from exc
            _cache = {**_cache, "stale": True}
        return _cache
