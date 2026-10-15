"""Keep current league fixtures independent of full-season, table and cup failures."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os

import requests

from darts_collector import collected_snapshot, persist_dataset, verified_payload
from darts_transport import scoped_get


def _read(url):
    response = scoped_get(requests.get, url,
                             headers={"Accept": "application/json", "Origin": "https://portal.3k-darts.com",
                                      "Referer": "https://portal.3k-darts.com/", "User-Agent": "Mozilla/5.0"},
                             timeout=(3, 8))
    response.raise_for_status()
    return response.json()


def load_league_fixtures(league, now, known_round_ids=()):
    from darts_feed import API, FRONTEND_API, _relevant_rounds, _season_match, _safe_venue
    base = f"{API}/{league['event']}/phase/{league['phase']}"
    phase = _read(base)
    if not isinstance(phase, dict) or not isinstance(phase.get("rounds"), list):
        raise ValueError("Invalid fixture phase")
    rounds = _relevant_rounds(phase["rounds"], now)
    rounds = list({r["id"]: r for r in [*rounds, *(r for r in phase["rounds"] if r.get("id") in known_round_ids)]}.values())
    if not rounds or len(rounds) > 6:
        raise ValueError("Incomplete fixture rounds")
    matches, venues = {}, {}
    for round_info in rounds:
        round_id = round_info.get("id")
        if not isinstance(round_id, int) or isinstance(round_id, bool) or round_id <= 0:
            raise ValueError("Invalid fixture round")
        payload = _read(f"{base}/round/{round_id}")
        if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
            raise ValueError("Incomplete fixture round")
        for raw in payload["matches"]:
            home, away = raw.get("participantHome") or {}, raw.get("participantGuest") or {}
            if not home.get("id") or not away.get("id") or raw.get("byeHome") or raw.get("byeAway"):
                continue
            if home["id"] not in league["teams"] and away["id"] not in league["teams"]:
                continue
            item = _season_match(raw, league, round_info, now)
            home_id = home["id"]
            if not isinstance(home_id, int) or isinstance(home_id, bool) or not 0 < home_id <= 100000000:
                raise ValueError("Invalid home team")
            venue = (home.get("teamSeason") or {}).get("playingVenue")
            if isinstance(venue, dict):
                venues[home_id] = _safe_venue(venue)
            if home_id not in venues:
                try:
                    detail = _read(f"{FRONTEND_API}/participant/{home_id}")
                    venue = ((detail.get("participant") or {}).get("teamSeason") or {}).get("playingVenue")
                    venues[home_id] = _safe_venue(venue) if isinstance(venue, dict) else None
                except (requests.RequestException, ValueError, TypeError, KeyError):
                    venues[home_id] = None
            item.update(homeVenue=venues[home_id] or {}, venueChecked=venues[home_id] is not None)
            matches[item["id"]] = item
    return {"available": True, "stale": False, "scope": "fixtures", "league": {"key": league["key"]},
            "roundIds": [r["id"] for r in rounds], "matches": list(matches.values()),
            "updatedAt": datetime.now(timezone.utc).isoformat()}


def refresh_fixture_snapshots():
    if os.getenv("DARTS_COLLECTOR_READ_ENABLED") != "1":
        return
    from darts_feed import LEAGUES
    now = datetime.now(timezone.utc)
    previous = collected_snapshot("season", 360, now)
    previous = overlay_fixtures(previous, now) if previous else None
    def collect(league):
        try:
            now = datetime.now(timezone.utc)
            key = "fixtures:" + league["key"]
            extra = set()
            for code in league["teams"].values():
                games = [m for m in (previous or {}).get("matches", []) if m.get("eventId") == league["event"]
                         and code in (m.get("barverTeams") or []) and m.get("kind") in {"upcoming", "live"}
                         and (m.get("kind") == "live" or _time(m.get("plannedAt")) >= now.timestamp())]
                if games:
                    round_id = min(games, key=lambda m: _time(m.get("plannedAt")) or float("inf")).get("roundId")
                    if isinstance(round_id, int) and not isinstance(round_id, bool) and round_id > 0:
                        extra.add(round_id)
            data = load_league_fixtures(league, now, extra)
            persist_dataset(key, verified_payload(key, data, datetime.now(timezone.utc)))
        except Exception as error:
            print(f"[DARTS FIXTURES] {league['key']}: {type(error).__name__}; erneuter Abruf automatisch.")
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(collect, LEAGUES))


def _time(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0


def overlay_fixtures(payload, now, ticker=False):
    """Overlay the newest observation; never freshen older tables or player statistics."""
    field = "items" if ticker else "matches"
    rows = {m["id"]: dict(m) for m in payload.get(field, [])}
    observations = []
    for key in ("kl04", "kk11"):
        delta = collected_snapshot("fixtures:" + key, 360, now)
        if not delta or delta.get("scope") != "fixtures" or delta.get("league", {}).get("key") != key:
            continue
        observations.append(delta)
        for change in delta.get("matches", []):
            previous = rows.get(change["id"], {})
            if _time(previous.get("fixtureObservedAt") or payload.get("updatedAt")) > _time(delta["updatedAt"]):
                continue
            merged = {**previous, **change, "fixtureObservedAt": delta["updatedAt"]}
            if change.get("venueChecked") is False and previous.get("homeTeamId") == change.get("homeTeamId"):
                merged["homeVenue"] = previous.get("homeVenue") or {}
            rows[change["id"]] = merged
    if not observations:
        return payload
    matches = sorted(rows.values(), key=lambda m: (m.get("plannedAt") or m.get("updatedAt") or "", m["id"]))
    result = {**payload, field: matches, "fixturesUpdatedAt": min(d["updatedAt"] for d in observations),
              "fixturesStale": len(observations) != 2 or any(d.get("stale") for d in observations)}
    if ticker:
        priority = {"live": 0, "upcoming": 1, "pending": 2, "final": 3}
        result[field] = sorted(matches, key=lambda m: (priority.get(m.get("kind"), 4),
            _time(m.get("plannedAt")) if m.get("kind") == "upcoming" else -_time(m.get("updatedAt"))))[:12]
    elif "teams" in payload:
        result["teams"] = []
        for team in payload["teams"]:
            games = [m for m in matches if team["code"] in (m.get("barverTeams") or [m.get("barverTeam")])]
            upcoming = [m for m in games if m.get("kind") in {"live", "upcoming"}]
            final = [m for m in games if m.get("kind") == "final"]
            result["teams"].append({**team, "matches": games, "nextMatch": upcoming[0] if upcoming else None,
                                    "lastMatch": final[-1] if final else None})
    return result
