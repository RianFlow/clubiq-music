"""Public training boards and transition alerts from the independent 3K live host."""
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock
import time
import requests

from darts_live import normalize_rest
from darts_tournament import _get, LIVE
from darts_training import get_trainings


def training_events(previous, current, event_id, new_game=False):
    """Never celebrate historical counters or a board's initial snapshot."""
    if not previous and not new_game:
        return []
    old = previous or {}
    common = {"matchId": event_id, "trainingId": event_id, "scope": "training",
              "gameId": current["matchKey"], "board": current.get("board"),
              "occurred_at": current.get("lastUpdate")}
    names = " & ".join(current[side]["name"] for side in ("home", "guest"))
    result = []
    early = all(isinstance(current[side].get("darts"), int) and
                0 <= current[side]["darts"] <= 3 and current[side].get("legs") == 0
                for side in ("home", "guest"))
    if current.get("active") and not current.get("finished") and not current.get("comingSoon") and not old.get("active") and early:
        result.append({**common, "type": "player_start", "player": names, "playerSide": "both"})
    if not previous:
        return result
    for side in ("home", "guest"):
        player, before = current[side], old.get(side) or {}
        for field, kind in (("count180", "180"), ("highFinish", "high_finish"), ("legs", "leg")):
            value, prior = player.get(field), before.get(field)
            if not isinstance(value, int) or not isinstance(prior, int) or value <= prior:
                continue
            if kind == "high_finish" and value < 100:
                continue
            result.append({**common, "type": kind, "player": player["name"],
                           "value": 180 if kind == "180" else value, "count": value if kind == "180" else 1,
                           "performanceId": f"{current['matchKey']}:{side}:{kind}:{value}",
                           "winnerSide": side, "legCount": value})
    if current.get("finished") and not old.get("finished"):
        home, away = current["home"].get("legs"), current["guest"].get("legs")
        if isinstance(home, int) and isinstance(away, int):
            result.append({**common, "type": "game", "player": names, "homeLegs": home,
                           "awayLegs": away, "text": f"{current['home']['name']} {home}:{away} {current['guest']['name']}"})
    return result


class TrainingLiveMonitor:
    def __init__(self, fetch=None, clock=None):
        self._fetch = fetch or _get
        self._clock = clock or time.time
        self._lock = RLock()
        self._states = {}
        self._events = []

    def apply(self, event_id, matches):
        now = self._clock()
        matches = [m for m in matches if m.get("groupKey") == str(event_id)]
        if not matches and event_id not in self._states:
            return
        with self._lock:
            state = self._states.setdefault(event_id, {"matches": {}, "lastSuccess": None, "stale": True})
            continuous = state["lastSuccess"] is not None and 0 <= now - state["lastSuccess"] <= 120
            for current in matches[:256]:
                if current.get("groupKey") != str(event_id):
                    continue
                key = current["matchKey"]
                previous = state["matches"].get(key)
                stamp = current.get("lastUpdateNs") or 0
                if previous and stamp <= (previous.get("lastUpdateNs") or 0):
                    continue
                fresh = 0 <= now - stamp / 1e9 <= 120
                if continuous and fresh:
                    self._events.extend(training_events(previous, current, event_id, new_game=True))
                state["matches"][key] = current
            # Keep only current boards from a successful full response. Empty responses
            # after an established game retain the last stand, visibly marked stale.
            if matches:
                keys = {m["matchKey"] for m in matches if m.get("groupKey") == str(event_id)}
                state["matches"] = {k: v for k, v in state["matches"].items() if k in keys}
            state["stale"] = not bool(matches)
            state["lastSuccess"] = now

    def poll(self, catalog=None):
        catalog = catalog if catalog is not None else get_trainings()
        now = datetime.fromtimestamp(self._clock(), timezone.utc)
        desired = []
        for event in catalog.get("events", []):
            try:
                date = datetime.fromisoformat(event["date"].replace("Z", "+00:00"))
                if date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
                age = (now - date).total_seconds()
            except (TypeError, ValueError, KeyError):
                continue
            if -43200 <= age <= 129600 and event.get("status") not in {"FINISH", "CANCELLED", "CANCELED", "ABORTED"}:
                desired.append(event["id"])
        for event_id in desired[:3]:
            try:
                raw = self._fetch(f"{LIVE}/match/5/0/{event_id}")
                rows = raw.get("data") if isinstance(raw, dict) else raw
                if not isinstance(rows, list) or len(rows) > 256:
                    raise ValueError("Incomplete training live response")
                self.apply(event_id, normalize_rest(raw))
            except (requests.RequestException, ValueError, KeyError, TypeError):
                # No synthetic events, history replay, or upstream exception payloads.
                with self._lock:
                    if event_id in self._states:
                        self._states[event_id]["stale"] = True
        with self._lock:
            for event_id in list(self._states):
                if event_id not in desired:
                    del self._states[event_id]

    def snapshot(self, event_id):
        with self._lock:
            state = self._states.get(event_id) or {}
            stamp = state.get("lastSuccess")
            return {"eventId": event_id, "matches": deepcopy(list((state.get("matches") or {}).values())),
                    "stale": state.get("stale", True) or stamp is None or self._clock() - stamp > 30,
                    "updatedAt": datetime.fromtimestamp(stamp, timezone.utc).isoformat() if stamp else None}

    def drain_events(self):
        with self._lock:
            result, self._events = self._events, []
            return result

    def requeue_events(self, events):
        with self._lock:
            self._events = events + self._events


training_live_monitor = TrainingLiveMonitor()
