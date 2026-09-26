from __future__ import annotations

from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from urllib.parse import urlencode

import requests


FRONTEND_API = "https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend"
API = f"{FRONTEND_API}/event"
LIVE_API = "https://live.3k-darts.com/dartsscorer-liveticker/api/v1"
LEAGUES = (
    {"key": "kl04", "name": "Kreisligen 04", "short": "KL 04", "event": 1445, "phase": 2139, "teams": {174110: "A", 174111: "B", 174112: "C"}},
    {"key": "kk11", "name": "Kreisklasse 11", "short": "KK 11", "event": 1460, "phase": 2154, "teams": {174266: "D"}},
)
BARVER_NAME_PREFIX = "sv barver darts"
TEAM_NUMBER_CODES = {"1": "A", "2": "B", "3": "C", "4": "D"}
SPECIAL_EVENT_TERMS = ("pokal", "cup", "freundschaft", "sonder")
CACHE_SECONDS = 45
SEASON_CACHE_SECONDS = 600
_cache: dict | None = None
_cache_time = 0.0
_lock = Lock()
_center_cache: dict[tuple[str, int], tuple[float, dict]] = {}
_season_cache: tuple[float, dict] | None = None
_special_cache: tuple[float, dict] | None = None
_match_cache: dict[int, tuple[float, dict]] = {}


class DartsFeedUnavailable(RuntimeError):
    pass


def _json(response: requests.Response):
    # 3K serves JSON without an explicit charset; its payload is UTF-8.
    response.encoding = "utf-8"
    return response.json()


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
        "eventId": event,
        "phaseId": phase,
        "roundId": round_id,
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


def _league_public(league: dict) -> dict:
    return {"key": league["key"], "name": league["name"], "short": league["short"]}


def _barver_code(item: dict, league: dict) -> str | None:
    return league["teams"].get(item.get("homeTeamId")) or league["teams"].get(item.get("awayTeamId"))


def _season_match(match: dict, league: dict, round_info: dict) -> dict:
    item = _ticker_item(match, league["phase"], int(round_info.get("id") or 0))
    barver_sides = {}
    if item.get("homeTeamId") in league["teams"]:
        barver_sides[league["teams"][item["homeTeamId"]]] = "home"
    if item.get("awayTeamId") in league["teams"]:
        barver_sides[league["teams"][item["awayTeamId"]]] = "away"
    item.update({
        "league": league["key"],
        "leagueName": league["name"],
        "leagueShort": league["short"],
        "round": _safe_round(round_info),
        "barverTeam": _barver_code(item, league),
        "barverTeams": sorted(barver_sides),
        "barverSides": barver_sides,
        "competitionType": "league",
        "competitionBadge": league["short"],
        "isSpecial": False,
    })
    return item


def _barver_code_from_name(name: str) -> str | None:
    """Map both league letters and cup numbers to ClubIQ's stable A-D codes."""
    normalized = " ".join(str(name or "").strip().split())
    lowered = normalized.casefold()
    if not lowered.startswith(BARVER_NAME_PREFIX):
        return None
    suffix = normalized[len("SV Barver Darts"):].strip().upper()
    if suffix in {"A", "B", "C", "D"}:
        return suffix
    return TEAM_NUMBER_CODES.get(suffix)


def _is_special_event(event: dict) -> bool:
    text = " ".join((
        str(event.get("name") or ""),
        str(event.get("nameShort") or ""),
        str((event.get("classification") or {}).get("name") or ""),
    )).casefold()
    return any(term in text for term in SPECIAL_EVENT_TERMS)


def _special_badge(event: dict) -> str:
    text = " ".join((str(event.get("name") or ""), str(event.get("nameShort") or ""))).casefold()
    if "pokal" in text or "cup" in text:
        return "POKAL"
    if "freund" in text:
        return "TESTSPIEL"
    return "SONDERSPIEL"


def _special_match(match: dict, event: dict, phase: dict, round_info: dict) -> dict | None:
    item = _ticker_item(match, int(phase.get("id") or 0), int(round_info.get("id") or 0))
    if item["home"] == "Unbekannt" or item["away"] == "Unbekannt":
        return None
    home_code = _barver_code_from_name(item["home"])
    away_code = _barver_code_from_name(item["away"])
    if not home_code and not away_code:
        return None
    barver_sides = {}
    if home_code:
        barver_sides[home_code] = "home"
    if away_code:
        barver_sides[away_code] = "away"
    badge = _special_badge(event)
    item.update({
        "league": f"special-{int(event.get('id') or 0)}",
        "leagueName": str(event.get("name") or "Sonderwettbewerb"),
        "leagueShort": badge,
        "round": _safe_round(round_info),
        "barverTeam": next(iter(sorted(barver_sides)), None),
        "barverTeams": sorted(barver_sides),
        "barverSides": barver_sides,
        "competitionType": "cup" if badge == "POKAL" else "special",
        "competitionBadge": badge,
        "isSpecial": True,
    })
    return item


def _average(participant: dict) -> float | None:
    darts, score = participant.get("darts"), participant.get("score")
    if isinstance(darts, (int, float)) and darts > 0 and isinstance(score, (int, float)):
        return round(score * 3 / darts, 1)
    return None


def _remaining_points(value) -> int | None:
    """Accept only an explicit 3K live `points` value, never report `score`."""
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 501 else None


def _public_live_games(payload) -> list[dict]:
    """Whitelist the small live-score subset published by 3K's public ticker."""
    raw_games = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(raw_games, list):
        return []
    games = []
    for raw in raw_games:
        if not isinstance(raw, dict) or not (raw.get("statusActive") is True or raw.get("status") == 1):
            continue
        players = raw.get("matchPlayers") or []
        if not isinstance(players, list) or len(players) < 2:
            continue
        players = [item for item in players if isinstance(item, dict)]
        home_players, away_players = players[::2], players[1::2]
        if not home_players or not away_players:
            continue

        def side(items: list[dict]) -> dict:
            names = [str(item.get("playerName") or "").strip() for item in items]
            names = [name for name in names if name]
            player = items[0]
            legs = player.get("legs")
            return {
                "name": " & ".join(names)[:160] or "Noch offen",
                "remaining": _remaining_points(player.get("points")),
                "legs": legs if isinstance(legs, int) and not isinstance(legs, bool) and 0 <= legs <= 25 else None,
            }

        current_index = raw.get("currentplayerIndex")
        games.append({
            "id": int(raw.get("id") or 0),
            "matchKey": str(raw.get("matchKey") or "")[:60],
            "home": side(home_players),
            "away": side(away_players),
            "currentSide": "home" if isinstance(current_index, int) and current_index % 2 == 0 else "away" if isinstance(current_index, int) else None,
            "lastUpdated": raw.get("lastUpdate"),
        })
    return games


def _live_game_events(payload, match: dict, team_name: str = "") -> list[dict]:
    events = []
    for game in _public_live_games(payload):
        home, away = game["home"], game["away"]
        home_legs, away_legs = home["legs"], away["legs"]
        leg_score = f"{home_legs}:{away_legs}" if isinstance(home_legs, int) and isinstance(away_legs, int) else "–"
        events.append({
            "type": "live_game",
            "title": "Aktuelle Partie",
            "text": f"{home['name']} {leg_score} {away['name']}",
            "matchId": int(match.get("id") or 0),
            "liveGameId": game["id"],
            "team": team_name,
            "homeName": home["name"],
            "awayName": away["name"],
            "homeLegs": home_legs,
            "awayLegs": away_legs,
            "homeRemaining": home["remaining"],
            "awayRemaining": away["remaining"],
            "currentSide": game["currentSide"],
            "updatedAt": game["lastUpdated"],
        })
    return events


def _public_game(game: dict) -> dict:
    home, away = game.get("participantHome") or {}, game.get("participantGuest") or {}
    number = int(game.get("gameNr") or game.get("gameNrRound") or 0)
    if number <= 4:
        block = "1. Block · Einzel"
    elif number <= 6:
        block = "2. Block · Doppel"
    elif number <= 10:
        block = "3. Block · Einzel"
    else:
        block = "4. Block · Doppel"
    home_legs = game.get("legsHome") if isinstance(game.get("legsHome"), int) else game.get("liveLegsHome")
    away_legs = game.get("legsAway") if isinstance(game.get("legsAway"), int) else game.get("liveLegsAway")
    return {
        "id": int(game.get("id") or 0),
        "number": number,
        "block": block,
        "status": str(game.get("statusCd") or "OPEN").upper(),
        "home": {"name": str(home.get("displayName") or "Noch offen")[:160], "average": _average(home)},
        "away": {"name": str(away.get("displayName") or "Noch offen")[:160], "average": _average(away)},
        "homeLegs": home_legs if isinstance(home_legs, int) else None,
        "awayLegs": away_legs if isinstance(away_legs, int) else None,
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


def _preferred_round(rounds: list[dict], now: datetime) -> dict | None:
    """Prefer a round whose published window contains now, then the next one."""
    dated = []
    for item in rounds:
        starts = _iso(item.get("dateFrom"))
        ends = _iso(item.get("dateTo")) or starts
        if starts:
            dated.append((item, starts, ends))
    active = [entry for entry in dated if entry[1] <= now <= entry[2]]
    if active:
        return max(active, key=lambda entry: entry[1])[0]
    upcoming = [entry for entry in dated if entry[1] > now]
    if upcoming:
        return min(upcoming, key=lambda entry: entry[1])[0]
    previous = [entry for entry in dated if entry[2] < now]
    return max(previous, key=lambda entry: entry[2])[0] if previous else (rounds[0] if rounds else None)


def _safe_round(item: dict) -> dict:
    return {
        "id": int(item.get("id") or 0),
        "name": str(item.get("name") or "Spieltag"),
        "dateFrom": item.get("dateFrom"),
        "dateTo": item.get("dateTo"),
    }


def _standings(matches: list[dict], team_ids: set[int]) -> list[dict]:
    """Return only 3K's official rank and public team label, never participant metadata."""
    entries: dict[int, dict] = {}
    for match in matches:
        for side in ("Home", "Guest"):
            participant = match.get(f"participant{side}") or {}
            participant_id = participant.get("id")
            rank = participant.get("rankingPos")
            if not isinstance(participant_id, int):
                continue
            entries[participant_id] = {
                "id": participant_id,
                "name": str(participant.get("displayName") or "Unbekannt"),
                "rank": rank if isinstance(rank, int) and rank > 0 else None,
                "barver": participant_id in team_ids,
            }
    return sorted(entries.values(), key=lambda entry: (entry["rank"] is None, entry["rank"] or 999, entry["name"]))


def _performance_events(payload: list[dict], match: dict) -> list[dict]:
    events = []
    for performance in payload:
        kind = performance.get("performanceTypeCd")
        value = performance.get("value")
        if kind == "HS" and value == 180:
            event_type, title = "180", "180!"
        elif kind == "HF" and isinstance(value, int) and 2 <= value <= 170:
            event_type, title = "high_finish", f"High Finish {value}"
        else:
            continue
        participant = performance.get("participant") or {}
        team = performance.get("team") or {}
        count = performance.get("count") if isinstance(performance.get("count"), int) else 1
        events.append({
            "type": event_type,
            "title": title,
            "text": f"{participant.get('displayName') or 'Spieler'} · {team.get('name') or 'Mannschaft'}" + (f" · {count}×" if count > 1 else ""),
            "matchId": int(match.get("id") or 0),
            "performanceId": int(performance.get("id") or 0),
            "player": str(participant.get("displayName") or "Spieler")[:100],
            "team": str(team.get("name") or "Mannschaft")[:120],
            "count": count,
            "value": value,
        })
    return events


def _game_events(payload: list[dict], match: dict, team_name: str = "", barver_side: str = "") -> list[dict]:
    finished = []
    for game in payload:
        home = game.get("participantHome") or {}
        away = game.get("participantGuest") or {}
        home_legs, away_legs = game.get("legsHome"), game.get("legsAway")
        if game.get("statusCd") != "FINISH" or not isinstance(home_legs, int) or not isinstance(away_legs, int) or home_legs == away_legs:
            continue
        winner = home if home_legs > away_legs else away
        loser = away if home_legs > away_legs else home
        winner_legs, loser_legs = (home_legs, away_legs) if home_legs > away_legs else (away_legs, home_legs)
        finished.append({
            "type": "game",
            "title": f"Spiel {game.get('gameNr') or game.get('gameNrRound') or ''} beendet".strip(),
            "text": f"{winner.get('displayName') or 'Sieger'} gewinnt {winner_legs}:{loser_legs} gegen {loser.get('displayName') or 'Gegner'}",
            "matchId": int(match.get("id") or 0),
            "gameId": int(game.get("id") or 0),
            "order": int(game.get("gameNr") or game.get("gameNrRound") or 0),
            "team": team_name,
            "player": str(winner.get("displayName") or "Sieger")[:100],
            "homeLegs": home_legs,
            "awayLegs": away_legs,
            "barverWon": (home_legs > away_legs) == (barver_side == "home") if barver_side in {"home", "away"} else None,
        })
    return sorted(finished, key=lambda item: item["order"], reverse=True)[:2]


def _leg_events(payload: list[dict], match: dict, team_name: str = "") -> list[dict]:
    events = []
    for game in payload:
        if game.get("statusCd") == "FINISH":
            continue
        home = game.get("participantHome") or {}
        away = game.get("participantGuest") or {}
        home_name = str(home.get("displayName") or "").strip()
        away_name = str(away.get("displayName") or "").strip()
        home_legs = game.get("liveLegsHome")
        away_legs = game.get("liveLegsAway")
        game_id = int(game.get("id") or 0)
        if not game_id or not home_name or not away_name or not isinstance(home_legs, int) or not isinstance(away_legs, int):
            continue
        for side, winner, count in (("home", home_name, home_legs), ("away", away_name, away_legs)):
            if count <= 0:
                continue
            events.append({
                "type": "leg",
                "title": f"Leg für {winner}",
                "text": f"{home_name} {home_legs}:{away_legs} {away_name}",
                "matchId": int(match.get("id") or 0),
                "gameId": game_id,
                "order": int(game.get("gameNr") or game.get("gameNrRound") or 0),
                "team": team_name,
                "player": winner[:100],
                "winnerSide": side,
                "legCount": count,
            })
    return events


def _load(now: datetime) -> dict:
    session = requests.Session()
    session.headers["User-Agent"] = "ClubIQ-Darts/1.0 (+https://barverdarts.clubiq.party/)"
    items: dict[int, dict] = {}
    for league in LEAGUES:
        phase_url = f"{API}/{league['event']}/phase/{league['phase']}"
        phase_response = session.get(phase_url, timeout=(3, 8))
        phase_response.raise_for_status()
        for round_info in _relevant_rounds(_json(phase_response).get("rounds") or [], now):
            round_id = int(round_info["id"])
            round_url = f"{phase_url}/round/{round_id}"
            round_response = session.get(round_url, timeout=(3, 8))
            round_response.raise_for_status()
            for match in _json(round_response).get("matches") or []:
                home_id, _ = _participant(match, "Home")
                away_id, _ = _participant(match, "Guest")
                if (home_id in league["teams"] or away_id in league["teams"]) and home_id and away_id and not match.get("byeHome") and not match.get("byeAway"):
                    item = _ticker_item(match, league["phase"], round_id)
                    sides = {}
                    if home_id in league["teams"]:
                        sides[league["teams"][home_id]] = "home"
                    if away_id in league["teams"]:
                        sides[league["teams"][away_id]] = "away"
                    item.update({
                        "league": league["key"],
                        "leagueName": league["name"],
                        "leagueShort": league["short"],
                        "barverTeam": next(iter(sorted(sides)), None),
                        "barverTeams": sorted(sides),
                        "barverSides": sides,
                        "competitionType": "league",
                        "competitionBadge": league["short"],
                        "isSpecial": False,
                    })
                    items[item["id"]] = item
    special = _get_special_events(now)
    for item in special.get("matches") or []:
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
        result = _load(now)
        with _lock:
            _cache = result
            _cache_time = timestamp
            return _cache
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        with _lock:
            if _cache:
                return {**_cache, "stale": True}
        raise DartsFeedUnavailable("3K-Ergebnisse sind gerade nicht erreichbar.") from exc


def get_darts_center(league_key: str = "kl04", round_id: int | None = None, now: datetime | None = None) -> dict:
    """Load one league round for ClubIQ's native sports view using a strict allowlist."""
    global _center_cache
    league = next((item for item in LEAGUES if item["key"] == league_key), None)
    if not league:
        raise ValueError("Unbekannte Liga.")
    requested_round_id = round_id
    now = now or datetime.now(timezone.utc)
    session = requests.Session()
    session.headers["User-Agent"] = "ClubIQ-Darts/1.0 (+https://barverdarts.clubiq.party/)"
    phase_url = f"{API}/{league['event']}/phase/{league['phase']}"
    try:
        phase_response = session.get(phase_url, timeout=(3, 8))
        phase_response.raise_for_status()
        phase = _json(phase_response)
        rounds = phase.get("rounds") or []
        allowed = {int(item.get("id") or 0): item for item in rounds}
        if round_id is not None and round_id not in allowed:
            raise ValueError("Dieser Spieltag gehört nicht zur gewählten Liga.")
        if round_id is None:
            chosen = _preferred_round(rounds, now)
            if not chosen:
                raise DartsFeedUnavailable("3K meldet für diese Liga keine Spieltage.")
            round_id = int(chosen["id"])
        cache_key = (league_key, round_id)
        with _lock:
            cached = _center_cache.get(cache_key)
            if cached and now.timestamp() - cached[0] < CACHE_SECONDS:
                return cached[1]
        round_response = session.get(f"{phase_url}/round/{round_id}", timeout=(3, 8))
        round_response.raise_for_status()
        all_matches = _json(round_response).get("matches") or []
        raw_matches = [match for match in all_matches if not match.get("byeHome") and not match.get("byeAway")]
        matches = [_ticker_item(match, league["phase"], round_id) for match in raw_matches]
        events = []
        barver_matches = []
        for raw_match, item in zip(raw_matches, matches):
            if item["homeTeamId"] not in league["teams"] and item["awayTeamId"] not in league["teams"]:
                continue
            barver_matches.append(item)
            barver_side = "home" if item["homeTeamId"] in league["teams"] else "away"
            barver_team = item["home"] if barver_side == "home" else item["away"]
            if item["kind"] == "final":
                events.append({"type": "match", "title": "Mannschaftsspiel beendet", "text": item["text"], "matchId": item["id"], "team": barver_team, "player": barver_team, "score": item["score"], "updatedAt": item["updatedAt"]})
            match_id = int(raw_match.get("id") or 0)
            if not match_id:
                continue
            if raw_match.get("hasPerformances"):
                perf = session.get(f"{API}/{league['event']}/performance/match/{match_id}?matchReport=1", timeout=(3, 8))
                perf_payload = _json(perf) if perf.ok else None
                if isinstance(perf_payload, list):
                    events.extend(_performance_events(perf_payload, raw_match))
            if item["kind"] in {"live", "final"}:
                if item["kind"] == "live":
                    try:
                        live = session.get(f"{LIVE_API}/match/10/0/{match_id}", timeout=(3, 8))
                        if live.ok:
                            events.extend(_live_game_events(_json(live), raw_match, barver_team))
                    except (requests.RequestException, ValueError, KeyError, TypeError):
                        # The match report below remains a safe fallback while
                        # 3K's dedicated live ticker is briefly unavailable.
                        pass
                report = session.get(f"{API}/{league['event']}/match/{match_id}/report", timeout=(3, 8))
                report_payload = _json(report) if report.ok else None
                if isinstance(report_payload, list):
                    events.extend(_game_events(report_payload, raw_match, barver_team, barver_side))
                    if item["kind"] == "live":
                        events.extend(_leg_events(report_payload, raw_match, barver_team))
        result = {
            "available": True,
            "stale": False,
            "updatedAt": now.isoformat(),
            "league": {"key": league["key"], "name": league["name"], "short": league["short"], "event": league["event"], "phase": league["phase"]},
            "rounds": [_safe_round(item) for item in rounds],
            "selectedRound": _safe_round(allowed[round_id]),
            "matches": matches,
            "barverMatches": barver_matches,
            "standings": _standings(all_matches, league["teams"]),
            "events": [event for event in events if event["type"] != "leg"][:12],
            "pushEvents": events,
        }
        with _lock:
            _center_cache[cache_key] = (now.timestamp(), result)
        return result
    except ValueError:
        raise
    except (requests.RequestException, KeyError, TypeError) as exc:
        with _lock:
            cached = [
                value for (key, cached_round_id), value in _center_cache.items()
                if key == league_key and (requested_round_id is None or requested_round_id == cached_round_id)
            ]
        if cached:
            _, result = max(cached, key=lambda value: value[0])
            return {**result, "stale": True}
        raise DartsFeedUnavailable("3K-Spieltag ist gerade nicht erreichbar.") from exc


def _public_get(url: str):
    response = requests.get(
        url,
        headers={"User-Agent": "ClubIQ-Darts/1.0 (+https://barverdarts.clubiq.party/)"},
        timeout=(3, 10),
    )
    response.raise_for_status()
    return _json(response)


def _load_special_events(now: datetime) -> dict:
    """Discover cup and other special events from the active public DVWE season."""
    anchor = _public_get(f"{API}/{LEAGUES[0]['event']}")
    anchor_event = anchor.get("event") or {}
    season_id = int((anchor_event.get("saison") or {}).get("id") or 0)
    mandant_key = int(anchor_event.get("mandantKey") or (anchor.get("mandant") or {}).get("mandantKey") or 0)
    region_id = int((anchor_event.get("region") or {}).get("id") or 0)
    if not season_id or not mandant_key:
        raise DartsFeedUnavailable("3K meldet keine aktive DVWE-Saison.")
    query = {
        "mandantKey": mandant_key,
        "eventTypeCd": "LEAGUE",
        "seasonId": season_id,
        "page": 0,
        "size": 100,
    }
    if region_id:
        query["regionId"] = region_id
    page = _public_get(f"{API}/page?{urlencode(query)}")
    known_events = {int(league["event"]) for league in LEAGUES}
    candidates = [
        event for event in page.get("content") or []
        if int(event.get("id") or 0) not in known_events and _is_special_event(event)
    ]
    matches: list[dict] = []
    public_events: list[dict] = []
    for summary in candidates:
        event_id = int(summary.get("id") or 0)
        if not event_id:
            continue
        try:
            detail = _public_get(f"{API}/{event_id}")
            event = detail.get("event") or summary
            event_matches = []
            for phase in detail.get("phases") or []:
                phase_id = int(phase.get("id") or 0)
                if not phase_id:
                    continue
                phase_data = _public_get(f"{API}/{event_id}/phase/{phase_id}")
                rounds = phase_data.get("rounds") or []
                for round_info in rounds:
                    round_id = int(round_info.get("id") or 0)
                    if not round_id:
                        continue
                    payload = _public_get(f"{API}/{event_id}/phase/{phase_id}/round/{round_id}")
                    for raw_match in payload.get("matches") or []:
                        if raw_match.get("byeHome") or raw_match.get("byeAway"):
                            continue
                        item = _special_match(raw_match, event, phase, round_info)
                        if item:
                            event_matches.append(item)
            event_matches.sort(key=lambda item: (item.get("plannedAt") or item.get("updatedAt") or "", item["id"]))
            if event_matches:
                badge = _special_badge(event)
                public_events.append({
                    "id": event_id,
                    "name": str(event.get("name") or "Sonderwettbewerb"),
                    "short": str(event.get("nameShort") or badge),
                    "badge": badge,
                    "sourceUrl": f"https://portal.3k-darts.com/frontend/events/10/event/{event_id}/participants",
                    "matchCount": len(event_matches),
                })
                matches.extend(event_matches)
        except (requests.RequestException, ValueError, KeyError, TypeError):
            # One malformed public competition must not hide the remaining schedule.
            continue
    matches.sort(key=lambda item: (item.get("plannedAt") or item.get("updatedAt") or "", item["id"]))
    return {
        "available": True,
        "updatedAt": now.isoformat(),
        "events": public_events,
        "matches": matches,
    }


def _get_special_events(now: datetime) -> dict:
    global _special_cache
    with _lock:
        cached = _special_cache
        if cached and now.timestamp() - cached[0] < SEASON_CACHE_SECONDS:
            return cached[1]
    try:
        result = _load_special_events(now)
        with _lock:
            _special_cache = (now.timestamp(), result)
        return result
    except (requests.RequestException, ValueError, KeyError, TypeError, DartsFeedUnavailable):
        with _lock:
            cached = _special_cache
        if cached:
            return {**cached[1], "stale": True}
        return {"available": False, "stale": True, "updatedAt": now.isoformat(), "events": [], "matches": []}


def _load_team_profile(team_id: int) -> dict:
    payload = _public_get(f"{FRONTEND_API}/participant/{team_id}")
    participant = payload.get("participant") or {}
    team = participant.get("teamSeason") or {}
    roster = []
    for member in team.get("teamMembers") or []:
        name = str(member.get("displayName") or (member.get("member") or {}).get("displayName") or "").strip()
        if not name:
            continue
        player = ((member.get("member") or {}).get("player") or {})
        player_id = player.get("id")
        role = "Kapitän" if member.get("tc1") else "Stellvertretung" if member.get("tc2") else "Spieler"
        roster.append({
            "id": int(player_id) if isinstance(player_id, int) and player_id > 0 else None,
            "name": name[:100],
            "role": role,
        })
    roster.sort(key=lambda item: (item["role"] == "Spieler", item["name"]))
    venue = team.get("playingVenue") or {}
    safe_venue = {
        "name": str(venue.get("name") or ""),
        "city": str(venue.get("locationCity") or ""),
        "postalCode": str(venue.get("locationPostalCode") or ""),
        "street": str(venue.get("locationStreet") or ""),
        "boards": venue.get("numberOfBoards") if isinstance(venue.get("numberOfBoards"), int) else None,
    }
    return {
        "name": str(participant.get("displayName") or team.get("name") or ""),
        "roster": roster,
        "venue": safe_venue,
        "weekday": team.get("weekdayMatch") if isinstance(team.get("weekdayMatch"), int) else None,
        "throwoffTime": str(team.get("throwoffTime") or "")[:8] or None,
    }


def _team_record(matches: list[dict], code: str) -> dict:
    results = [item for item in matches if item.get("kind") == "final" and code in (item.get("barverTeams") or [])]
    results.sort(key=lambda item: item.get("updatedAt") or item.get("plannedAt") or "")
    wins = draws = losses = sets_for = sets_against = 0
    form = []
    for item in results:
        try:
            home_score, away_score = (int(value) for value in str(item.get("score") or "").split(":"))
        except (TypeError, ValueError):
            continue
        side = (item.get("barverSides") or {}).get(code)
        own, other = (home_score, away_score) if side == "home" else (away_score, home_score)
        sets_for += own
        sets_against += other
        if own > other:
            wins += 1
            form.append("S")
        elif own < other:
            losses += 1
            form.append("N")
        else:
            draws += 1
            form.append("U")
    return {
        "played": wins + draws + losses,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "setsFor": sets_for,
        "setsAgainst": sets_against,
        "form": form[-5:],
    }


def _load_league_season(league: dict, now: datetime) -> dict:
    phase_url = f"{API}/{league['event']}/phase/{league['phase']}"
    phase = _public_get(phase_url)
    rounds = phase.get("rounds") or []
    round_matches: dict[int, list[dict]] = {}

    def load_round(round_info: dict) -> tuple[int, list[dict]]:
        round_id = int(round_info.get("id") or 0)
        payload = _public_get(f"{phase_url}/round/{round_id}")
        matches = [
            item for item in payload.get("matches") or []
            if not item.get("byeHome") and not item.get("byeAway")
        ]
        return round_id, matches

    # A season currently has 18 rounds. A small bounded pool keeps the first
    # ClubIQ load responsive without flooding 3K's public service.
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = {executor.submit(load_round, item): item for item in rounds}
        for job in as_completed(jobs):
            round_id, matches = job.result()
            round_matches[round_id] = matches

    public_matches: list[dict] = []
    for round_info in rounds:
        for raw_match in round_matches.get(int(round_info.get("id") or 0), []):
            home_id, _ = _participant(raw_match, "Home")
            away_id, _ = _participant(raw_match, "Guest")
            if home_id in league["teams"] or away_id in league["teams"]:
                public_matches.append(_season_match(raw_match, league, round_info))

    public_matches.sort(key=lambda item: (item.get("plannedAt") or item.get("updatedAt") or "", item["id"]))
    selected = _preferred_round(rounds, now)
    selected_matches = round_matches.get(int((selected or {}).get("id") or 0), [])
    return {
        "league": _league_public(league),
        "rounds": [_safe_round(item) for item in rounds],
        "selectedRound": _safe_round(selected) if selected else None,
        "standings": _standings(selected_matches, set(league["teams"])),
        "matches": public_matches,
    }


def _load_season(now: datetime) -> dict:
    leagues = [_load_league_season(league, now) for league in LEAGUES]
    special = _get_special_events(now)
    all_matches = [match for league in leagues for match in league["matches"]]
    all_matches.extend(special.get("matches") or [])
    all_matches.sort(key=lambda item: (item.get("plannedAt") or item.get("updatedAt") or "", item["id"]))
    standings_by_id = {
        entry["id"]: entry
        for league in leagues
        for entry in league["standings"]
    }
    profiles = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = {
            executor.submit(_load_team_profile, team_id): (team_id, code)
            for league in LEAGUES for team_id, code in league["teams"].items()
        }
        for job in as_completed(jobs):
            _, code = jobs[job]
            try:
                profiles[code] = job.result()
            except (requests.RequestException, ValueError, KeyError, TypeError):
                profiles[code] = {"name": "", "roster": [], "venue": {}, "weekday": None, "throwoffTime": None}
    teams = []
    for league in LEAGUES:
        for team_id, code in league["teams"].items():
            matches = [item for item in all_matches if code in (item.get("barverTeams") or [])]
            results = [item for item in matches if item["kind"] == "final"]
            upcoming = [item for item in matches if item["kind"] != "final"]
            standing = standings_by_id.get(team_id) or {}
            profile = profiles.get(code) or {}
            teams.append({
                "code": code,
                "id": team_id,
                "name": profile.get("name") or standing.get("name") or f"SV Barver Darts {code}",
                "league": _league_public(league),
                "rank": standing.get("rank"),
                "nextMatch": upcoming[0] if upcoming else None,
                "lastMatch": results[-1] if results else None,
                "matches": matches,
                "record": _team_record(matches, code),
                "roster": profile.get("roster") or [],
                "venue": profile.get("venue") or {},
                "weekday": profile.get("weekday"),
                "throwoffTime": profile.get("throwoffTime"),
            })
    return {
        "available": True,
        "stale": False,
        "updatedAt": now.isoformat(),
        "leagues": leagues,
        "specialEvents": special.get("events") or [],
        "specialEventsAvailable": bool(special.get("available")),
        "teams": sorted(teams, key=lambda item: item["code"]),
        "matches": all_matches,
    }


def get_darts_season(now: datetime | None = None) -> dict:
    global _season_cache
    now = now or datetime.now(timezone.utc)
    with _lock:
        cached = _season_cache
        if cached and now.timestamp() - cached[0] < SEASON_CACHE_SECONDS:
            return cached[1]
    try:
        result = _load_season(now)
        with _lock:
            _season_cache = (now.timestamp(), result)
        return result
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        with _lock:
            cached = _season_cache
        if cached:
            return {**cached[1], "stale": True}
        raise DartsFeedUnavailable("Der 3K-Saisonspielplan ist gerade nicht erreichbar.") from exc


def get_darts_match(match_id: int, now: datetime | None = None) -> dict:
    global _match_cache
    now = now or datetime.now(timezone.utc)
    season = get_darts_season(now)
    match = next((item for item in season.get("matches") or [] if item.get("id") == match_id), None)
    if not match:
        raise ValueError("Diese Begegnung gehört nicht zu einem freigegebenen Barver-Spielplan.")
    ttl = CACHE_SECONDS if match["kind"] == "live" else SEASON_CACHE_SECONDS
    with _lock:
        cached = _match_cache.get(match_id)
        if cached and now.timestamp() - cached[0] < ttl:
            return cached[1]
    event_id = int(match.get("eventId") or 0)
    if not event_id:
        league = next((item for item in LEAGUES if item["key"] == match.get("league")), None)
        event_id = int((league or {}).get("event") or 0)
    if not event_id:
        raise ValueError("Für diese Begegnung fehlt die 3K-Wettbewerbskennung.")
    try:
        report = _public_get(f"{API}/{event_id}/match/{match_id}/report")
        if not isinstance(report, list):
            report = []
        try:
            performance_payload = _public_get(f"{API}/{event_id}/performance/match/{match_id}?matchReport=1")
        except requests.RequestException:
            performance_payload = []
        performances = _performance_events(performance_payload, {"id": match_id}) if isinstance(performance_payload, list) else []
        live_games = []
        if match["kind"] == "live":
            try:
                live_games = _public_live_games(_public_get(f"{LIVE_API}/match/10/0/{match_id}"))
            except (requests.RequestException, ValueError, KeyError, TypeError):
                pass
        result = {
            "available": True,
            "stale": False,
            "updatedAt": now.isoformat(),
            "match": match,
            "games": sorted((_public_game(item) for item in report), key=lambda item: item["number"]),
            "liveGames": live_games,
            "performances": performances,
            "sourceUrl": match["url"],
        }
        with _lock:
            _match_cache[match_id] = (now.timestamp(), result)
        return result
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        with _lock:
            cached = _match_cache.get(match_id)
        if cached:
            return {**cached[1], "stale": True}
        raise DartsFeedUnavailable("Der 3K-Spielbericht ist gerade nicht erreichbar.") from exc
