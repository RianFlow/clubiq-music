"""Durable, server-driven tracking of the four Barver teams.

Only normalized public fixtures/boards are persisted. A missing fixture is not
a cancellation, and a clinched victory is not the end of a 12-game encounter.
"""
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock

TEAMS = ("A", "B", "C", "D")
SUMMARY_SECONDS = 600
WATCH_WINDOW = 8 * 3600
FIXTURE_FIELDS = (
    "id", "home", "away", "barverTeam", "barverTeams", "barverSides", "league",
    "competitionBadge", "competitionType", "plannedAt", "url", "score", "updatedAt",
    "kind", "homeVenue", "awayVenue",
)


def stamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()
    except (ValueError, TypeError):
        return 0


def codes(item):
    values = item.get("barverTeams") or [item.get("barverTeam")]
    return [code for code in TEAMS if code in values or
            any(item.get(side) == f"SV Barver Darts {code}" for side in ("home", "away"))]


class TeamMatchWatch:
    def __init__(self, hub, load_fixtures, load_state, save_state, clock=None):
        self.hub, self.load_fixtures = hub, load_fixtures
        self.load_state, self.save_state = load_state, save_state
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.lock = RLock()
        self.restored = False
        self.entries = {}
        self.next_check = 0
        self.last_check = self.last_success = self.last_error = None
        self.teams = []
        self._status = {"teams": [], "lastCheck": None, "lastSuccess": None, "error": None}

    def poll(self):
        with self.lock:
            now = self.clock()
            seconds, iso = now.timestamp(), now.isoformat()
            if not self.restored:
                saved = self.load_state() or {}
                self.entries = {key: value for key, value in saved.get("entries", {}).items()
                                if str(key).isdigit() and isinstance(value, dict) and codes(value.get("match", {}))}
                live = saved.get("live", {})
                self.hub.restore_snapshot({"groups": [group for group in live.get("groups", []) if str(group.get("groupKey")) in self.entries]})
                self.last_success = saved.get("lastSuccess")
                self.restored = True
            if seconds >= self.next_check:
                self.last_check = iso
                try:
                    season = self.load_fixtures()
                    trusted = not season.get("stale") and not season.get("degraded")
                    for item in season.get("matches", []):
                        key = str(item.get("id", ""))
                        if not key.isdigit() or not codes(item):
                            continue
                        if item.get("kind") == "final" and (not trusted or key not in self.entries):
                            continue
                        if item.get("kind") not in ("upcoming", "live", "pending", "final"):
                            continue
                        known = self.hub.get_group(key) or {}
                        if known.get("finished") and item.get("kind") != "final":
                            continue
                        previous = self.entries.setdefault(key, {})
                        # A stale feed may seed appointments, but cannot undo a
                        # verified status or a later, authoritative reschedule.
                        if trusted or not previous.get("match"):
                            previous["match"] = {field: deepcopy(item[field]) for field in FIXTURE_FIELDS if field in item}
                    if trusted:
                        self.last_success, self.last_error = iso, None
                    else:
                        self.last_error = "Spielplan derzeit nicht aktuell"
                except Exception as exc:
                    # The known match IDs keep running even if the league source fails.
                    self.last_error = type(exc).__name__
                imminent = any(-WATCH_WINDOW <= stamp(entry["match"].get("plannedAt")) - seconds <= 1800
                               for entry in self.entries.values() if entry["match"].get("kind") != "final")
                self.next_check = seconds + (30 if imminent or self.last_error else 300)
            stable = []
            for key, entry in list(self.entries.items()):
                item = entry["match"]
                planned = stamp(item.get("plannedAt"))
                expiry = stamp(entry.get("finishedAt")) + SUMMARY_SECONDS if entry.get("finishedAt") else planned + WATCH_WINDOW
                if expiry and expiry < seconds:
                    del self.entries[key]
                    continue
                stable.append({**item, "kind": "upcoming"} if item.get("kind") == "pending" else item)
            self.hub.reconcile(stable)
            for key, entry in self.entries.items():
                item, group = entry["match"], self.hub.get_group(key) or {}
                boards = group.get("matches") or []
                confirmed = any(not board.get("comingSoon") and (board.get("active") or board.get("finished")) for board in boards) and not group.get("retired")
                if group.get("finished") or item.get("kind") == "final":
                    entry.setdefault("finishedAt", group.get("finishedAt") or item.get("updatedAt") or iso)
                    item["kind"] = "final"
                    state = "finished"
                elif confirmed:
                    state = "interrupted" if group.get("stale") or seconds - stamp(group.get("lastSuccess")) > 120 else "live"
                    if not entry.get("startHandled"):
                        # A reconnect in the middle of a match is not a kickoff.
                        fresh_start = any(
                            board.get("active") and not board.get("finished") and not board.get("comingSoon")
                            and -5 <= seconds - (board.get("lastUpdateNs") or 0) / 1e9 <= 90
                            and board.get("teamScoreHome") == 0 and board.get("teamScoreGuest") == 0
                            and (entry.get("armed") or all(
                                player.get("legs") == 0 and isinstance(player.get("darts"), int) and 0 <= player["darts"] <= 6
                                for player in (board.get("home") or {}, board.get("guest") or {})
                            ))
                            for board in boards
                        )
                        if fresh_start:
                            self.hub.requeue_events([
                                {"type": "match_start", "matchId": int(key), "team": f"SV Barver Darts {code}",
                                 "player": f"SV Barver Darts {code}", "home": item.get("home"), "away": item.get("away"),
                                 "occurred_at": iso} for code in codes(item)
                            ])
                        entry["startHandled"] = True
                else:
                    state = "waiting" if stamp(item.get("plannedAt")) <= seconds else "upcoming"
                    if stamp(item.get("plannedAt")) >= seconds - 600:
                        entry["armed"] = True
                entry["state"] = state
                self.hub.set_watch_state(key, state, entry.get("finishedAt"))
            teams = []
            priority = {"live": 0, "interrupted": 0, "waiting": 1, "finished": 2, "upcoming": 3}
            for code in TEAMS:
                candidates = [entry for entry in self.entries.values() if code in codes(entry["match"])]
                entry = min(candidates, key=lambda value: (priority[value["state"]], stamp(value["match"].get("plannedAt"))), default=None)
                group = self.hub.get_group(str(entry["match"]["id"])) if entry else None
                teams.append({"team": code, "state": entry["state"] if entry else "idle",
                                   "match": deepcopy(entry["match"]) if entry else None,
                                   "lastCheck": self.last_check, "lastSuccess": group.get("lastSuccess") if group else self.last_success,
                                   "connected": bool(group and group.get("connected")), "error": self.last_error})
            self.teams = teams
            self._status = {"lastCheck": self.last_check, "lastSuccess": self.last_success,
                            "error": self.last_error, "teams": teams}
            self.save_state({"updatedAt": iso, "entries": deepcopy(self.entries), "lastSuccess": self.last_success,
                             "live": self.hub.snapshot()})

    def status(self):
        return deepcopy(self._status)

    def overlay(self, payload, field="matches"):
        """Publish the same verified state to the website and Web-App APIs."""
        items = {str(item["id"]): deepcopy(item) for item in payload.get(field, [])}
        for group in self.hub.snapshot().get("groups", []):
            key, state = group["groupKey"], group.get("watchState")
            if group.get("retired") or state not in ("waiting", "live", "interrupted", "finished"):
                continue
            if state == "finished" and stamp(group.get("summaryUntil")) <= self.clock().timestamp():
                continue
            item = {**group.get("meta", {}), **items.get(key, {})}
            if item.get("kind") == "final" and state != "finished":
                continue
            item["kind"] = "final" if state == "finished" else "upcoming" if state == "waiting" else "live"
            item.update(watchState=state, finishedAt=group.get("finishedAt"), summaryUntil=group.get("summaryUntil"), liveFeedDelayed=state == "interrupted")
            boards = group.get("matches") or []
            latest = max(boards, key=lambda board: (board.get("teamScoreHome", 0) or 0) + (board.get("teamScoreGuest", 0) or 0), default={})
            if state == "finished" and group.get("meta", {}).get("kind") == "final" and group["meta"].get("score"):
                item["score"] = group["meta"]["score"]
            elif all(isinstance(latest.get(k), int) for k in ("teamScoreHome", "teamScoreGuest")):
                item["score"] = f"{latest['teamScoreHome']}:{latest['teamScoreGuest']}"
            items[key] = item
        return {**payload, field: list(items.values())}
