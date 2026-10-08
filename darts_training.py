"""Discover public SV Barver trainings without guessing event numbers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from zoneinfo import ZoneInfo
import json
import time
import requests

from darts_feed import _public_get
from darts_resilience import load_snapshot, save_snapshot, last_known
from darts_collector import collected_snapshot
from darts_tournament import _load, _detail

API = "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend/event"
MANDANT = 1931
SEED = json.loads((Path(__file__).parent / "static/darts-trainings.json").read_text(encoding="utf-8"))
_catalog = None
_catalog_attempt = 0.0
_catalog_lock = Lock()
_event_lock = Lock()
_event_cache = {}


class InvalidTraining(ValueError):
    pass


def training_model(raw):
    if not isinstance(raw, dict) or raw.get("mandantKey") != MANDANT or "training" not in str(raw.get("name") or "").casefold():
        return None
    event_id = raw.get("id")
    if not isinstance(event_id, int) or isinstance(event_id, bool) or not 0 < event_id <= 10000000 or raw.get("dbId", 5) != 5:
        return None
    return {"id": event_id, "name": " ".join(str(raw["name"]).split())[:160],
            "date": raw.get("datetime") if isinstance(raw.get("datetime"), str) else None,
            "status": str(raw.get("statusCd") or "")[:30],
            "source": f"https://portal.3k-darts.com/frontend/events/5/event/{event_id}/participants"}


def select_training(events, now=None):
    now = now or datetime.now(timezone.utc)
    def date(event):
        try:
            parsed = datetime.fromisoformat(str(event.get("date") or "").replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except (ValueError, OverflowError):
            return None
    events = [e for e in events if date(e) and date(e).year >= 1900 and e["status"] not in {"CANCELLED", "CANCELED", "ABORTED"}]
    active = [e for e in events if e["status"] in {"ACTIVE", "RUNNING", "STARTED"}]
    upcoming = [e for e in events if e["status"] not in {"FINISH", "CANCELLED", "CANCELED", "ABORTED"}
                and date(e).astimezone(ZoneInfo("Europe/Berlin")).date() >= now.astimezone(ZoneInfo("Europe/Berlin")).date()]
    next_event = min(upcoming, key=date) if upcoming else None
    selected = max(active, key=date) if active else next_event or (max(events, key=date) if events else None)
    return {"selectedId": selected["id"] if selected else None, "nextId": next_event["id"] if next_event else None}


def _discover(previous):
    events = {e["id"]: e for e in previous.get("events") or []}
    pages = 1
    for page in range(10):
        payload = _public_get(f"{API}/page?mandantKey={MANDANT}&eventTypeCd=TOURNAMENT&filterText=Training&page={page}&size=100")
        if not isinstance(payload.get("content"), list):
            raise ValueError("Ungültige Trainingsliste")
        pages = payload.get("totalPages", 1)
        if not isinstance(pages, int) or not 0 <= pages <= 10:
            raise ValueError("Unvollständige Trainingsliste")
        for raw in payload["content"]:
            event = training_model(raw)
            if event:
                events[event["id"]] = event
        if page + 1 >= pages:
            break
    # Known direct links can remain absent from the public organizer listing.
    def detail(event_id):
        try:
            return training_model((_public_get(f"{API}/{event_id}").get("event") or {}))
        except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError):
            return None
    stale = False
    with ThreadPoolExecutor(max_workers=4) as pool:
        for event in pool.map(detail, list(events)[:50]):
            if event:
                events[event["id"]] = event
            else:
                stale = True
    ordered = sorted(events.values(), key=lambda e: e.get("date") or "", reverse=True)[:50]
    return {"available": True, "stale": stale, "degraded": stale,
            "updatedAt": previous["updatedAt"] if stale else datetime.now(timezone.utc).isoformat(),
            "events": ordered, **select_training(ordered)}


def get_trainings(force=False):
    global _catalog, _catalog_attempt
    collected = collected_snapshot("training-catalog", 360)
    if collected and not force:
        return {**collected, **select_training(collected["events"])}
    previous = collected or _catalog or load_snapshot("training-catalog") or SEED
    # Newly confirmed links must also reach visitors with an older saved catalog.
    events = list({e["id"]: e for e in [*SEED["events"], *previous["events"]]}.values())
    previous = {**previous, "events": events, **select_training(events)}
    age = time.monotonic() - _catalog_attempt
    if _catalog_attempt and age < (30 if force or previous.get("stale") else 300):
        return {**previous, **select_training(previous["events"])}
    if not _catalog_lock.acquire(blocking=False):
        return last_known({**previous, **select_training(previous["events"])})
    try:
        _catalog_attempt = time.monotonic()
        try:
            _catalog = _discover(previous)
            save_snapshot("training-catalog", _catalog)
        except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError):
            _catalog = last_known(previous)
        return {**_catalog, **select_training(_catalog["events"])}
    finally:
        _catalog_lock.release()


def get_training(event_id=None):
    event_id = event_id or get_trainings()["selectedId"]
    if not isinstance(event_id, int) or isinstance(event_id, bool) or not 0 < event_id <= 10000000:
        raise ValueError("Ungültiges Training")
    key = f"training:{event_id}"
    collected = collected_snapshot(key, 360)
    if collected:
        return collected
    cached = _event_cache.get(event_id)
    previous = cached[1] if cached and cached[1] else load_snapshot(key)
    now = time.monotonic()
    ttl = 300 if previous and previous.get("event", {}).get("status") == "FINISH" and not previous.get("stale") and not previous.get("degraded") else 30
    if cached and now - cached[0] < ttl:
        if previous:
            return previous
        raise RuntimeError("Trainingsdaten werden erneut geprüft.")
    if not _event_lock.acquire(blocking=False):
        if previous:
            return {**last_known(previous), "source": previous.get("source")}
        raise RuntimeError("Trainingsdaten werden geladen.")
    source = f"https://portal.3k-darts.com/frontend/events/5/event/{event_id}/participants"
    try:
        detail, _, _, _ = _detail(source)
        if not training_model(detail.get("event")):
            raise InvalidTraining("Dieser Link gehört nicht zu einem Training von SV Barver.")
        result = _load(source, extras=True)
        for key in ("performances", "placements"):
            if result.get(key + "Unavailable") and previous:
                result[key] = previous.get(key, [])
        if not result.get("degraded"):
            save_snapshot(key, result)
        _event_cache[event_id] = (now, result)
        return result
    except InvalidTraining:
        raise
    except (requests.RequestException, ValueError, TypeError, KeyError, AttributeError) as exc:
        saved = {**last_known(previous), "source": previous.get("source")} if previous else None
        _event_cache[event_id] = (now, saved)
        if previous:
            return saved
        raise RuntimeError("Die Trainingsdaten sind gerade nicht erreichbar.") from exc
    finally:
        if len(_event_cache) > 32:
            del _event_cache[min(_event_cache, key=lambda k: _event_cache[k][0])]
        _event_lock.release()
