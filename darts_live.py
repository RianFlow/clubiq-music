from __future__ import annotations

import hashlib
import json
import queue
import random
import re
import secrets
import threading
import time
from datetime import datetime, timezone
import requests

try:
    import websocket
except ImportError:  # Tests and development still have the REST fallback.
    websocket = None


LIVE_API = "https://live.3k-darts.com/dartsscorer-liveticker/api/v1"
SOCKJS_URL = "wss://live.3k-darts.com/dartsscorer-liveticker/api/v1/websocket"
USER_AGENT = "ClubIQ-Darts/1.0 (+https://barverdarts.clubiq.party/)"
REST_FALLBACK_SECONDS = 7
RECONNECT_SECONDS = 5
LIVE_WATCH_EARLY_SECONDS = 30 * 60
LIVE_WATCH_LATE_SECONDS = 8 * 60 * 60
TEAM_MATCH_GAMES = 12
_STAMP = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$")


def _integer(value, minimum: int = 0, maximum: int = 10_000_000) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(value)
    return number if minimum <= number <= maximum else None


def _text(value, maximum: int = 160) -> str:
    return " ".join(str(value or "").split())[:maximum]


def timestamp_ns(value: str | None) -> int:
    """Parse ISO timestamps without losing 3K's nanosecond ordering."""
    match = _STAMP.fullmatch(str(value or ""))
    if not match:
        return 0
    base, fraction, zone = match.groups()
    try:
        parsed = datetime.fromisoformat(base + (zone or "+00:00").replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return 0
    seconds = int(parsed.astimezone(timezone.utc).timestamp())
    nanos = int(((fraction or "") + "000000000")[:9])
    return seconds * 1_000_000_000 + nanos


def _watch_live_candidate(item: dict, now: datetime | None = None) -> bool:
    """Watch imminent/recent matches directly on 3K live even if the league feed still says upcoming."""
    if item.get("kind") == "live":
        return True
    if item.get("kind") != "upcoming":
        return False
    try:
        planned = datetime.fromisoformat(str(item.get("plannedAt") or "").replace("Z", "+00:00"))
    except ValueError:
        return False
    if planned.tzinfo is None:
        planned = planned.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    seconds_since_start = (current.astimezone(timezone.utc) - planned.astimezone(timezone.utc)).total_seconds()
    return -LIVE_WATCH_EARLY_SECONDS <= seconds_since_start <= LIVE_WATCH_LATE_SECONDS


def _player(items: list[dict]) -> dict:
    first = items[0] if items else {}
    names = [_text(item.get("playerName"), 80) for item in items]
    names = [name for name in names if name]
    total_score = sum(_integer(item.get("scoreTotal"), 0, 100_000) or 0 for item in items)
    total_darts = sum(_integer(item.get("dartsTotal"), 0, 10_000) or 0 for item in items)

    def total(field: str, maximum: int = 10_000) -> int:
        return sum(_integer(item.get(field), 0, maximum) or 0 for item in items)

    return {
        "id": _integer(first.get("id"), 1),
        "name": " & ".join(names)[:160] or "Noch offen",
        "points": _integer(first.get("points"), 0, 501),
        "lastScore": _integer(first.get("lastScore"), 0, 180),
        "darts": _integer(first.get("darts"), 0, 100),
        "legs": _integer(first.get("legs"), 0, 25),
        "average": round(total_score / total_darts * 3, 1) if total_darts else None,
        "count60": total("count60"),
        "count80": total("count80"),
        "count100": total("count100"),
        "count140": total("count140"),
        "count180": total("count180"),
        "highFinish": max((_integer(item.get("highfinish"), 0, 170) or 0 for item in items), default=0),
    }


def normalize_match(raw: dict) -> dict | None:
    """Turn an untrusted 3K payload into ClubIQ's small public live model."""
    if not isinstance(raw, dict):
        return None
    match_key = _text(raw.get("matchKey"), 60)
    group_key = _text(raw.get("groupKey"), 60)
    match_id = _integer(raw.get("id"), 1)
    players = [item for item in (raw.get("matchPlayers") or []) if isinstance(item, dict)]
    if not match_key or not group_key or not match_id or len(players) < 2:
        return None
    indexed = sorted(players, key=lambda item: _integer(item.get("index"), 0, 99) or 0)
    home_items = [item for item in indexed if (_integer(item.get("index"), 0, 99) or 0) % 2 == 0]
    guest_items = [item for item in indexed if (_integer(item.get("index"), 0, 99) or 0) % 2 == 1]
    if not home_items or not guest_items:
        home_items, guest_items = indexed[::2], indexed[1::2]
    current = _integer(raw.get("currentplayerIndex"), 0, 99)
    last_update = _text(raw.get("lastUpdate"), 40)
    return {
        "id": match_id,
        "matchKey": match_key,
        "groupKey": group_key,
        "board": _text(raw.get("board"), 20),
        "mode": _text(raw.get("mode"), 80),
        "roundName": _text(raw.get("roundName"), 100),
        "groupName": _text(raw.get("groupName"), 200),
        "home": _player(home_items),
        "guest": _player(guest_items),
        "currentPlayerIndex": current if current in (0, 1) else (current % 2 if current is not None else None),
        "teamScoreHome": _integer(raw.get("setsHome"), 0, 99),
        "teamScoreGuest": _integer(raw.get("setsGuest"), 0, 99),
        "totalLegsHome": _integer(raw.get("legsHome"), 0, 999),
        "totalLegsGuest": _integer(raw.get("legsGuest"), 0, 999),
        "comingSoon": raw.get("statusComingSoon") is True,
        "active": raw.get("statusActive") is True or raw.get("status") == 1,
        "finished": raw.get("statusFinished") is True,
        "lastUpdate": last_update or None,
        "lastUpdateNs": timestamp_ns(last_update),
    }


def normalize_rest(payload) -> list[dict]:
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    return [mapped for raw in rows if (mapped := normalize_match(raw))]


def _event_id(*parts) -> str:
    return hashlib.sha256("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def detect_events(previous: dict | None, current: dict, meta: dict) -> list[dict]:
    """Detect state transitions only; an initial snapshot never creates alerts."""
    if not previous:
        return []
    group_key = int(current["groupKey"]) if current["groupKey"].isdigit() else current["groupKey"]
    team_sides = meta.get("barverSides") or {}
    events = []
    occurred = current.get("lastUpdate")
    for side, key in (("home", "home"), ("guest", "guest")):
        old_player, player = previous.get(key) or {}, current.get(key) or {}
        code = next((code for code, configured in team_sides.items() if configured == ("away" if side == "guest" else side)), None)
        if not code:
            continue
        team_name = f"SV Barver Darts {code}"
        old_legs, new_legs = old_player.get("legs"), player.get("legs")
        if isinstance(old_legs, int) and isinstance(new_legs, int) and new_legs > old_legs:
            events.append({
                "type": "leg", "matchId": group_key, "gameId": current["id"], "winnerSide": side,
                "legCount": new_legs, "team": team_name, "player": player["name"], "barverWon": True,
                "title": f"Leg für {player['name']}",
                "text": f"{current['home']['name']} {current['home'].get('legs', 0)}:{current['guest'].get('legs', 0)} {current['guest']['name']}",
                "occurred_at": occurred,
            })
        old_180, new_180 = old_player.get("count180") or 0, player.get("count180") or 0
        if new_180 > old_180:
            events.append({
                "type": "180", "matchId": group_key, "performanceId": f"{current['matchKey']}:{side}:180:{new_180}",
                "value": 180, "count": new_180, "team": team_name, "player": player["name"], "occurred_at": occurred,
            })
        old_finish, new_finish = old_player.get("highFinish") or 0, player.get("highFinish") or 0
        if new_finish > old_finish and new_finish >= 100:
            events.append({
                "type": "high_finish", "matchId": group_key, "performanceId": f"{current['matchKey']}:{side}:hf:{new_finish}",
                "value": new_finish, "count": 1, "team": team_name, "player": player["name"], "occurred_at": occurred,
            })

    home_before, guest_before = previous.get("teamScoreHome"), previous.get("teamScoreGuest")
    home_now, guest_now = current.get("teamScoreHome"), current.get("teamScoreGuest")
    score_changed = all(isinstance(value, int) for value in (home_before, guest_before, home_now, guest_now)) and (home_now > home_before or guest_now > guest_before)
    if score_changed:
        winner_side = "home" if home_now > home_before else "away"
        code = next((code for code, side in team_sides.items() if side == winner_side), None)
        if code:
            events.append({
                "type": "game", "matchId": group_key, "gameId": f"{group_key}:{home_now}:{guest_now}", "homeLegs": home_now,
                "awayLegs": guest_now, "barverWon": True, "team": f"SV Barver Darts {code}",
                "player": current[winner_side if winner_side == "home" else "guest"]["name"],
                "text": f"Neuer Mannschaftsstand {home_now}:{guest_now}", "occurred_at": occurred,
            })
    for event in events:
        event["event_id"] = _event_id(current["groupKey"], current["matchKey"], event["type"], event.get("performanceId"), event.get("gameId"), event.get("legCount"), event.get("score"), event.get("value"))
    return events


class DartsLiveHub:
    def __init__(self, connector_factory=None):
        self._lock = threading.RLock()
        self._groups: dict[str, dict] = {}
        self._connectors: dict[str, _GroupConnector] = {}
        self._subscribers: set[queue.Queue] = set()
        self._events: queue.Queue = queue.Queue()
        self._revision = 0
        self._connector_factory = connector_factory or _GroupConnector

    def stop(self) -> None:
        with self._lock:
            connectors = list(self._connectors.values())
            self._connectors.clear()
        for connector in connectors:
            connector.stop()

    def reconcile(self, matches: list[dict]) -> None:
        desired = {}
        finalized = {}
        now = datetime.now(timezone.utc)
        for item in matches:
            group_key = str(item.get("id") or "")
            if not group_key.isdigit():
                continue
            meta = {
                key: item.get(key) for key in (
                    "id", "home", "away", "barverTeam", "barverTeams", "barverSides", "league",
                    "competitionBadge", "plannedAt", "url", "score", "updatedAt", "kind",
                )
            }
            if item.get("kind") == "final":
                finalized[group_key] = meta
                continue
            with self._lock:
                group = self._groups.get(group_key)
                recent_boards = item.get("kind") == "pending" and group and any(
                    board.get("active") and not board.get("finished") and
                    0 <= now.timestamp() - (board.get("lastUpdateNs") or 0) / 1e9 < 600
                    for board in group.get("matches", {}).values()
                )
            if not _watch_live_candidate(item, now) and not recent_boards:
                continue
            desired[group_key] = meta
        with self._lock:
            for group_key, meta in finalized.items():
                group = self._groups.get(group_key)
                if not group:
                    continue
                group["meta"] = {**(group.get("meta") or {}), **meta}
                group["finished"] = True
                group["finalizedBySeason"] = True
                group["connected"] = False
                group["source"] = "season"
                group["lastUpdate"] = meta.get("updatedAt") or group.get("lastUpdate")
                self._revision += 1
                group["revision"] = self._revision
                self._broadcast({"type": "live-group-update", "revision": self._revision, "group": self._public_group(group)})
            for group_key, meta in desired.items():
                group = self._groups.setdefault(group_key, self._empty_group(group_key, meta))
                group["retired"] = False
                group["meta"] = meta
                if group_key not in self._connectors and not group.get("finished"):
                    connector = self._connector_factory(self, "10", group_key)
                    self._connectors[group_key] = connector
                    connector.start()
            obsolete = [key for key in self._connectors if key not in desired]
            connectors = [self._connectors.pop(key) for key in obsolete]
            # Retire watchers with no official final score instead of preserving
            # an empty or old board as a permanent live event.
            for key, group in self._groups.items():
                if key not in desired and key not in finalized and not group.get("retired") and not group.get("finished"):
                    group["retired"] = True
                    group["connected"] = False
                    self._revision += 1
                    group["revision"] = self._revision
                    self._broadcast({"type": "live-status", "revision": self._revision, "group": self._public_group(group)})
        for connector in connectors:
            connector.stop()

    def _empty_group(self, group_key: str, meta: dict) -> dict:
        return {
            "groupKey": group_key, "database": "10", "meta": meta, "matches": {}, "connected": False,
            "source": "starting", "stale": False, "finished": False, "finalizedBySeason": False,
            "lastUpdate": None, "lastSuccess": None, "lastError": None, "revision": 0,
        }

    def apply(self, group_key: str, matches: list[dict], source: str) -> bool:
        changed = False
        emitted = []
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            group = self._groups.setdefault(group_key, self._empty_group(group_key, {"id": int(group_key)}))
            had_matches = bool(group["matches"])
            was_finished = bool(group.get("finished"))
            for current in matches:
                if current.get("groupKey") != group_key:
                    continue
                key = current["matchKey"]
                previous = group["matches"].get(key)
                incoming_stamp = current.get("lastUpdateNs") or 0
                stored_stamp = (previous or {}).get("lastUpdateNs") or 0
                if previous and incoming_stamp and stored_stamp and incoming_stamp <= stored_stamp:
                    continue
                if previous == current:
                    continue
                emitted.extend(detect_events(previous, current, group.get("meta") or {}))
                group["matches"][key] = current
                changed = True
            group["source"] = source
            group["stale"] = False
            group["lastSuccess"] = now
            group["lastError"] = None
            if group["matches"]:
                group["lastUpdate"] = max((item.get("lastUpdate") or "" for item in group["matches"].values()), default="") or now
                # 3K's live endpoint exposes the current board games. Between blocks,
                # every returned board can be finished although the team match is not.
                # Use the aggregate team score instead: DVWE league/cup matches contain
                # 12 individual games, so only a 12-game aggregate is the real finish.
                totals = [
                    (item.get("teamScoreHome"), item.get("teamScoreGuest"))
                    for item in group["matches"].values()
                ]
                group["finished"] = bool(group.get("finalizedBySeason")) or any(
                    isinstance(home, int) and isinstance(guest, int) and home + guest >= TEAM_MATCH_GAMES
                    for home, guest in totals
                )
            if had_matches and not was_finished and group["finished"]:
                latest = max(group["matches"].values(), key=lambda item: item.get("lastUpdateNs") or 0)
                code = next(iter(group.get("meta", {}).get("barverTeams") or []), None)
                if code:
                    home_score, guest_score = latest.get("teamScoreHome"), latest.get("teamScoreGuest")
                    emitted.append({
                        "type": "match", "matchId": int(group_key), "team": f"SV Barver Darts {code}",
                        "player": f"SV Barver Darts {code}", "score": f"{home_score}:{guest_score}",
                        "text": f"{group['meta'].get('home') or 'Heim'} {home_score}:{guest_score} {group['meta'].get('away') or 'Gast'}",
                        "occurred_at": latest.get("lastUpdate"),
                        "event_id": _event_id(group_key, "match", home_score, guest_score),
                    })
            if changed:
                self._revision += 1
                group["revision"] = self._revision
                # Transition events belong only to this update. Never retain them in
                # snapshots: a reconnect must not replay old celebrations.
                public_group = self._public_group(group)
                public_group["events"] = emitted
                message = {"type": "live-group-update", "revision": self._revision, "group": public_group}
                self._broadcast(message)
        for event in emitted:
            self._events.put(event)
        return changed

    def set_connection(self, group_key: str, connected: bool, error: str | None = None) -> None:
        with self._lock:
            group = self._groups.get(group_key)
            if not group:
                return
            group["connected"] = connected
            group["stale"] = bool(error) and not group.get("lastSuccess")
            group["lastError"] = _text(error, 120) if error else None
            self._revision += 1
            group["revision"] = self._revision
            self._broadcast({"type": "live-status", "revision": self._revision, "group": self._public_group(group)})

    def connector_finished(self, group_key: str, connector) -> None:
        with self._lock:
            if self._connectors.get(group_key) is connector:
                self._connectors.pop(group_key, None)

    def group_finished(self, group_key: str) -> bool:
        with self._lock:
            return bool(self._groups.get(group_key, {}).get("finished"))

    def _public_group(self, group: dict) -> dict:
        result = {key: group.get(key) for key in (
            "groupKey", "database", "meta", "connected", "source", "stale", "finished", "lastUpdate",
            "lastSuccess", "lastError", "revision", "retired",
        )}
        result["matches"] = sorted(group["matches"].values(), key=lambda item: (item.get("board") or "", item["matchKey"]))
        return result

    def snapshot(self) -> dict:
        with self._lock:
            groups = [self._public_group(group) for group in self._groups.values()]
            groups.sort(key=lambda group: group["groupKey"])
            return {"type": "live-snapshot", "revision": self._revision, "groups": groups, "updatedAt": datetime.now(timezone.utc).isoformat()}

    def get_group(self, group_key: str) -> dict | None:
        with self._lock:
            group = self._groups.get(str(group_key))
            return self._public_group(group) if group else None

    def subscribe(self) -> queue.Queue:
        channel = queue.Queue(maxsize=20)
        with self._lock:
            self._subscribers.add(channel)
        return channel

    def unsubscribe(self, channel: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(channel)

    def _broadcast(self, message: dict) -> None:
        for channel in tuple(self._subscribers):
            try:
                channel.put_nowait(message)
            except queue.Full:
                try:
                    channel.get_nowait()
                    channel.put_nowait(message)
                except (queue.Empty, queue.Full):
                    pass

    def drain_events(self) -> list[dict]:
        events = []
        while True:
            try:
                events.append(self._events.get_nowait())
            except queue.Empty:
                return events

    def requeue_events(self, events: list[dict]) -> None:
        for event in events:
            self._events.put(event)


class _GroupConnector:
    def __init__(self, hub: DartsLiveHub, database: str, group_key: str):
        self.hub = hub
        self.database = database
        self.group_key = group_key
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"3k-live-{group_key}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _rest_sync(self) -> bool:
        response = requests.get(
            f"{LIVE_API}/match/{self.database}/0/{self.group_key}",
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout=(3, 10),
        )
        response.raise_for_status()
        response.encoding = "utf-8"
        matches = normalize_rest(response.json())
        self.hub.apply(self.group_key, matches, "rest")
        return bool(matches)

    def _sockjs_url(self) -> str:
        server = f"{random.SystemRandom().randrange(1000):03d}"
        session = secrets.token_urlsafe(8).replace("-", "a").replace("_", "b")[:8]
        return f"{SOCKJS_URL}/{server}/{session}/websocket"

    @staticmethod
    def _sockjs_send(ws, frame: str) -> None:
        ws.send(json.dumps([frame], separators=(",", ":")))

    @staticmethod
    def _frames(message) -> list[str]:
        if not isinstance(message, str) or not message.startswith("a"):
            return []
        try:
            frames = json.loads(message[1:])
            return [frame for frame in frames if isinstance(frame, str)] if isinstance(frames, list) else []
        except ValueError:
            return []

    def _connect_and_listen(self) -> None:
        if websocket is None:
            raise RuntimeError("WebSocket-Modul fehlt; REST-Fallback aktiv.")
        ws = websocket.create_connection(self._sockjs_url(), timeout=10, header=[f"User-Agent: {USER_AGENT}"])
        try:
            ws.settimeout(2)
            opened = ws.recv()
            if opened != "o":
                raise RuntimeError("3K-SockJS-Verbindung wurde nicht geöffnet.")
            self._sockjs_send(ws, "CONNECT\naccept-version:1.2,1.1,1.0\nheart-beat:10000,10000\n\n\x00")
            connected = False
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not connected:
                for frame in self._frames(ws.recv()):
                    connected = frame.startswith("CONNECTED")
            if not connected:
                raise RuntimeError("3K-STOMP-Anmeldung ohne Antwort.")
            self._sockjs_send(ws, f"SUBSCRIBE\nid:clubiq-{self.group_key}\ndestination:/topic/{self.database}-{self.group_key}\nack:auto\n\n\x00")
            self._rest_sync()  # Fill any gap between the initial request and subscription.
            self.hub.set_connection(self.group_key, True)
            last_heartbeat = time.monotonic()
            while not self._stop.is_set() and not self.hub.group_finished(self.group_key):
                try:
                    message = ws.recv()
                except Exception as exc:
                    if websocket and isinstance(exc, websocket.WebSocketTimeoutException):
                        if time.monotonic() - last_heartbeat >= 10:
                            self._sockjs_send(ws, "\n")
                            last_heartbeat = time.monotonic()
                        continue
                    raise
                if message == "h":
                    continue
                for frame in self._frames(message):
                    if not frame.startswith("MESSAGE") or "\n\n" not in frame:
                        continue
                    body = frame.split("\n\n", 1)[1].rstrip("\x00")
                    try:
                        payload = json.loads(body)
                    except ValueError:
                        continue
                    match = normalize_match(payload.get("match") if isinstance(payload, dict) else None)
                    if match:
                        self.hub.apply(self.group_key, [match], "stomp")
        finally:
            try:
                ws.close()
            except Exception:
                pass
            self.hub.set_connection(self.group_key, False)

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                try:
                    self._rest_sync()
                    if self.hub.group_finished(self.group_key):
                        break
                    self._connect_and_listen()
                    if self.hub.group_finished(self.group_key):
                        self._rest_sync()
                        break
                except (requests.RequestException, ValueError, RuntimeError, OSError) as exc:
                    self.hub.set_connection(self.group_key, False, type(exc).__name__)
                    if self._stop.wait(REST_FALLBACK_SECONDS if websocket is None else RECONNECT_SECONDS):
                        break
                    try:
                        self._rest_sync()
                    except (requests.RequestException, ValueError):
                        pass
        finally:
            self.hub.connector_finished(self.group_key, self)


darts_live_hub = DartsLiveHub()
