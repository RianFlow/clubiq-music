"""Public tournament feed, isolated from league monitoring and push subscriptions."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Lock
from urllib.parse import urlsplit
import re
import time

import requests
from darts_live import normalize_rest
from darts_transport import scoped_get

BASE = "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend/event/22536"
SOURCE = "https://portal.3k-darts.com/frontend/events/5/event/22536/participants"
LIVE = "https://live.3k-darts.com/dartsscorer-liveticker/api/v1"
BACKENDS = {5: "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend", 10: "https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend"}
_lock = Lock()
_cache = None
_cache_key = None
_attempt = 0.0


def _get(url):
    response = scoped_get(requests.get, url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://portal.3k-darts.com/", "Origin": "https://portal.3k-darts.com", "Accept": "application/json"}, timeout=(3, 8), allow_redirects=False)
    if 300 <= response.status_code < 400:
        raise ValueError("Unexpected source redirect")
    response.raise_for_status()
    response.encoding = "utf-8"
    return response.json()


def _number(value):
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 10000000 else None


def _text(value):
    return " ".join(str(value or "").split())[:160]


def tournament_source(source=SOURCE):
    """Never fetch a user URL: derive the endpoint from an exact public portal path."""
    parsed = urlsplit(source.strip())
    match = re.fullmatch(r"/frontend/events/([0-9]+)/event/([0-9]+)(?:/[A-Za-z0-9/_-]*)?/?", parsed.path)
    if parsed.scheme != "https" or parsed.hostname != "portal.3k-darts.com" or parsed.username or parsed.password or parsed.port not in (None, 443) or not match:
        raise ValueError("Bitte den öffentlichen HTTPS-Turnierlink aus dem 3K-Portal einfügen.")
    database, event_id = map(int, match.groups())
    if database not in BACKENDS or not 0 < event_id <= 10000000:
        raise ValueError("Dieser 3K-Bereich wird noch nicht unterstützt. Unterstützt sind die Bereiche 5 und 10.")
    canonical = f"https://portal.3k-darts.com/frontend/events/{database}/event/{event_id}/participants"
    return database, event_id, f"{BACKENDS[database]}/event/{event_id}", canonical


def _detail(source):
    database, event_id, base, canonical = tournament_source(source)
    detail = _get(base)
    event = detail.get("event") or {}
    if event.get("id") != event_id or event.get("dbId") != database:
        raise ValueError("Unexpected tournament source")
    model = {"id": event_id, "database": database, "name": _text(event.get("name")), "date": event.get("datetime"), "status": _text(event.get("statusCd"))}
    return detail, model, base, canonical


def preview_tournament(source):
    _, event, _, canonical = _detail(source)
    return {"event": event, "source": canonical}


def group_models(payload, phase, round_id):
    groups = []
    info = payload.get("tableInfo") or {}
    for index, group in enumerate(info.get("tableEntries") or []):
        if not isinstance(group, dict) or not isinstance(group.get("tableEntries"), list):
            continue
        entries = []
        for row in group["tableEntries"]:
            if not isinstance(row, dict):
                continue
            entries.append({"rank": _text(row.get("placement")), "name": _text(row.get("participantName")),
                            "played": _number(row.get("matchCount")), "wins": _number(row.get("win")),
                            "lost": _number(row.get("lost")), "pointsFor": _number(row.get("points1")),
                            "pointsAgainst": _number(row.get("points2")), "legsFor": _number(row.get("legs1")),
                            "legsAgainst": _number(row.get("legs2"))})
        groups.append({"id": f"{phase}-{round_id}-{index}", "name": _text(group.get("name")) or "Gruppe",
                       "phaseId": phase, "roundId": round_id, "entries": entries})
    return groups


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
    base, phase, round_id = job
    payload = _get(f"{base}/phase/{phase}/round/{round_id}")
    if not isinstance(payload.get("matches"), list):
        raise ValueError("Incomplete match schedule")
    return {"matches": [model for raw in payload.get("matches", []) if isinstance(raw, dict) and (model := match_model(raw))],
            "groups": group_models(payload, phase, round_id)}


def _live_snapshot(event_id, database=5):
    """Return the active 3K scorer rows for one tournament event, keyed by backend match id."""
    try:
        games = normalize_rest(_get(f"{LIVE}/match/{database}/0/{event_id}"))
    except (requests.RequestException, ValueError, TypeError):
        return {}
    result = {}
    for game in games:
        if not game.get("active") or game.get("finished"):
            continue
        match_key = str(game.get("matchKey") or "")
        if match_key.isdigit():
            result[int(match_key)] = game
    return result


def performance_models(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("performanceCatalog"), list):
        raise ValueError("Incomplete performances")
    rows = []
    for catalog in payload.get("performanceCatalog") or []:
        kind = catalog.get("performanceTypeCd")
        if kind not in {"HS", "HF", "SG", "SGD"}:
            continue
        for item in catalog.get("playerPerformances") or []:
            value = _number(item.get("value"))
            name = _text((item.get("participant") or {}).get("displayName"))
            if name and value is not None and (kind != "HS" or value == 180):
                rows.append({"type": kind, "name": name, "value": value, "count": _number(item.get("count"))})
    return rows


def placement_models(payload):
    if not isinstance(payload, list):
        raise ValueError("Incomplete placements")
    return [{"rank": _text(item.get("place")), "name": _text((item.get("participant") or {}).get("displayName"))}
            for item in payload if isinstance(item, dict) and (item.get("participant") or {}).get("displayName")]


def _load(source=SOURCE, extras=False):
    detail, event, base, canonical = _detail(source)
    participants = _get(f"{base}/participant")
    if not isinstance(participants, list):
        raise ValueError("Incomplete participants")
    # Deliberately exclude payment, registration and other personal metadata.
    players = [{"id": _number(item.get("id")), "name": _text(item.get("displayName")), "waiting": item.get("waitingList") is True}
               for item in participants if isinstance(item, dict)]
    jobs = []
    phases = detail.get("phases") or []
    if extras and (not isinstance(detail.get("phases"), list) or len(phases) > 16):
        raise ValueError("Incomplete training phases")
    for phase in phases:
        if not isinstance(phase, dict):
            continue
        phase_id = _number(phase.get("id"))
        if phase_id:
            data = _get(f"{base}/phase/{phase_id}")
            if not isinstance(data.get("rounds"), list):
                raise ValueError("Incomplete phase")
            jobs.extend((base, phase_id, round_id) for row in data.get("rounds", []) if isinstance(row, dict) and (round_id := _number(row.get("id"))))
    if len(jobs) > 128:
        raise ValueError("Too many tournament rounds")
    rows = {}
    groups = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(_round, jobs):
            rows.update({match["id"]: match for match in result["matches"]})
            groups.extend(result["groups"])
    live_by_match = {} if extras and event["status"] == "FINISH" else _live_snapshot(event["id"], event["database"])
    for match_id, live in live_by_match.items():
        match = rows.get(match_id)
        if not match:
            continue
        match["live"] = live
        match["kind"] = "live"
        if live.get("board"):
            match["board"] = live["board"]
    live_matches = [match for match in rows.values() if match["kind"] == "live"]
    result = {"event": event, "groups": groups,
            "participants": players, "matches": list(rows.values()), "source": canonical,
            "updatedAt": datetime.now(timezone.utc).isoformat(), "stale": False,
            "scheduleReady": bool(jobs), "livePointsAvailable": any(match["live"] for match in live_matches)}
    if extras:
        for suffix, parser, key in (("performance", performance_models, "performances"), ("placement", placement_models, "placements")):
            try:
                result[key] = parser(_get(f"{base}/{suffix}"))
            except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError):
                result[key] = []
                result[key + "Unavailable"] = True
                result["degraded"] = True
    return result


def get_tournament(source=SOURCE):
    global _cache, _attempt, _cache_key
    key = tournament_source(source)[:2]
    with _lock:
        if key != _cache_key:
            _cache, _attempt, _cache_key = None, 0.0, key
        if _cache is not None and time.monotonic() - _attempt < 15:
            return _cache
        if time.monotonic() - _attempt < 15:
            raise RuntimeError("Turnierdaten vorübergehend nicht erreichbar")
        _attempt = time.monotonic()
        try:
            _cache = _load(source)
        except (requests.RequestException, ValueError, TypeError, KeyError, AttributeError) as exc:
            if _cache is None:
                raise RuntimeError("Turnierdaten vorübergehend nicht erreichbar") from exc
            _cache = {**_cache, "stale": True}
        return _cache


_series_cache = {}
_series_lock = Lock()


def get_series_tournament(source):
    """Keep independently selected ranking rounds separate from the admin default."""
    key = tournament_source(source)[:2]
    with _series_lock:
        cached = _series_cache.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < 15:
            if cached[1] is None:
                raise RuntimeError("Turnierdaten vorübergehend nicht erreichbar")
            return cached[1]
        try:
            result = _load(source)
        except (requests.RequestException, ValueError, TypeError, KeyError, AttributeError) as exc:
            result = {**cached[1], "stale": True} if cached and cached[1] else None
            if result is None:
                _series_cache[key] = (now, None)
                raise RuntimeError("Turnierdaten vorübergehend nicht erreichbar") from exc
        if len(_series_cache) >= 32 and key not in _series_cache:
            del _series_cache[min(_series_cache, key=lambda item: _series_cache[item][0])]
        _series_cache[key] = (now, result)
        return result
