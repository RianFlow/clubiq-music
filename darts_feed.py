from __future__ import annotations

from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from urllib.parse import urlencode

import re
import time

import requests

from darts_resilience import PublicSession, source_recovery, save_snapshot, load_snapshot, last_known
from darts_collector import collected_snapshot
from darts_transport import scoped_get
from darts_live import darts_live_hub, _watch_live_candidate


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
SPECIAL_EVENTS_CACHE_SECONDS = 300
PLAYER_STATS_CACHE_SECONDS = 3600
PLAYER_MATCH_STATS_CACHE_SECONDS = 900
_cache: dict | None = None
_cache_time = 0.0
_lock = Lock()
_season_load_lock = Lock()
_feed_load_lock = Lock()
_center_cache: dict[tuple[str, int], tuple[float, dict]] = {}
_season_cache: tuple[float, dict] | None = None
_special_cache: tuple[float, dict] | None = None
_match_cache: dict[int, tuple[float, dict]] = {}
_player_stats_cache: tuple[float, dict] | None = None
_player_stats_retry_at = 0.0
_player_stats_load_lock = Lock()
_venue_cache: dict[int, tuple[float, dict]] = {}
_player_match_stats_cache: dict[tuple[int, int], tuple[float, tuple[list[dict], list[dict]]]] = {}


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


def _public_gender(*values) -> str | None:
    """Keep only a small, presentation-safe gender marker from public 3K data."""
    female = {"F", "FEMALE", "W", "WEIBLICH", "FRAU"}
    male = {"M", "MALE", "MÄNNLICH", "MAENNLICH", "MANN"}
    diverse = {"D", "DIVERSE", "DIVERS"}
    for value in values:
        marker = str(value or "").strip().upper()
        if marker in female:
            return "female"
        if marker in male:
            return "male"
        if marker in diverse:
            return "diverse"
    return None


def _participant(match: dict, side: str) -> tuple[int | None, str]:
    participant = match.get(f"participant{side}") or {}
    return participant.get("id"), str(participant.get("displayName") or "Unbekannt")


def _ticker_item(match: dict, phase: int, round_id: int, now: datetime | None = None) -> dict:
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
    # A past scheduled time is not evidence of a result. Stop advertising an old
    # unreported match as live/upcoming, but do not invent a winner or end score.
    if now and planned and kind != "final":
        scheduled = planned if planned.tzinfo else planned.replace(tzinfo=timezone.utc)
        if (now - scheduled).total_seconds() > 8 * 3600:
            kind = "pending"
            text = f"{home} gegen {away} · Vorläufig beendet – Bestätigung ausstehend"
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


def _season_match(match: dict, league: dict, round_info: dict, now: datetime | None = None) -> dict:
    item = _ticker_item(match, league["phase"], int(round_info.get("id") or 0), now)
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


def _preferred_round_by_matches(rounds: list[dict], round_matches: dict[int, list[dict]], now: datetime) -> dict | None:
    """Keep the oldest started matchday with unfinished fixtures selected.

    3K fixtures can be moved far outside their matchday's published date window.
    A calendar-only choice would then skip an unfinished matchday even though it
    still contains an open match.
    """
    unfinished = []
    for item in rounds:
        starts = _iso(item.get("dateFrom"))
        if not starts or starts > now:
            continue
        matches = [
            match for match in round_matches.get(int(item.get("id") or 0), [])
            if not match.get("byeHome") and not match.get("byeAway")
        ]
        if matches and any(str(match.get("statusCd") or "OPEN").upper() != "FINISH" for match in matches):
            unfinished.append((starts, item))
    if unfinished:
        return min(unfinished, key=lambda entry: entry[0])[1]
    return _preferred_round(rounds, now)


def _round_status(round_info: dict, matches: list[dict]) -> dict:
    playable = [match for match in matches if not match.get("byeHome") and not match.get("byeAway")]
    open_matches = [match for match in playable if str(match.get("statusCd") or "OPEN").upper() != "FINISH"]
    starts = _iso(round_info.get("dateFrom"))
    ends = _iso(round_info.get("dateTo")) or starts
    moved = 0
    if starts and ends:
        for match in playable:
            planned = _iso(match.get("datePlanned"))
            # 3K publishes matchday windows as calendar days, usually at
            # midnight.  Compare dates so a normal evening fixture on the
            # final matchday is not mistaken for a postponed match.
            if planned and not (starts.date() <= planned.date() <= ends.date()):
                moved += 1
    return {
        "complete": bool(playable) and not open_matches,
        "openMatches": len(open_matches),
        "movedMatches": moved,
    }


def _safe_round(item: dict) -> dict:
    return {
        "id": int(item.get("id") or 0),
        "name": str(item.get("name") or "Spieltag"),
        "dateFrom": item.get("dateFrom"),
        "dateTo": item.get("dateTo"),
    }


def _standings(matches: list[dict], team_ids: set[int]) -> list[dict]:
    """Keep public team labels when the table is unavailable; fixture seeds are not ranks."""
    entries: dict[int, dict] = {}
    for match in matches:
        for side in ("Home", "Guest"):
            participant = match.get(f"participant{side}") or {}
            participant_id = participant.get("id")
            if not isinstance(participant_id, int):
                continue
            entries[participant_id] = {
                "id": participant_id,
                "name": str(participant.get("displayName") or "Unbekannt"),
                "rank": None,
                "barver": participant_id in team_ids,
            }
    return sorted(entries.values(), key=lambda entry: entry["name"])


def _table_placement(value) -> int | None:
    """3K's placement is the current table place; participantRankingPos is a seed."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value if value > 0 else None
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+)\.?\s*", value)
        if match:
            rank = int(match.group(1))
            return rank if rank > 0 else None
    return None


def _official_standings(payload: dict, team_ids: set[int]) -> list[dict]:
    """Whitelist published 3K league totals; never copy participant metadata."""
    rows = []
    for group in payload.get("tableEntries") or []:
        for entry in group.get("tableEntries") or []:
            identifier = entry.get("participantId")
            if not isinstance(identifier, int) or isinstance(identifier, bool):
                continue
            row = {"id": identifier, "name": str(entry.get("participantName") or "Unbekannt"),
                   "rank": _table_placement(entry.get("placement")), "rankSource": "3k-placement",
                   "barver": identifier in team_ids}
            for public, source in (("played", "matchCount"), ("wins", "win"), ("draws", "tie"),
                                   ("losses", "lost"), ("pointsFor", "points1"), ("pointsAgainst", "points2"),
                                   ("setsFor", "sets1"), ("setsAgainst", "sets2"),
                                   ("legsFor", "legs1"), ("legsAgainst", "legs2")):
                value = entry.get(source)
                row[public] = value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
            rows.append(row)
    return rows


def _league_standings(league: dict, matches: list[dict]) -> list[dict]:
    try:
        payload = _public_get(f"{API}/{league['event']}/phase/0/round/0/table")
        rows = _official_standings(payload, set(league["teams"]))
        if rows:
            return rows
    except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError):
        pass
    return _standings(matches, set(league["teams"]))


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
    session = PublicSession()
    session.headers.update({
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://portal.3k-darts.com",
        "Referer": "https://portal.3k-darts.com/",
    })
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
                    item = _ticker_item(match, league["phase"], round_id, now)
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
    if special.get("available") is not True or special.get("stale") or special.get("degraded"):
        raise DartsFeedUnavailable("3K-Sonderbegegnungen konnten gerade nicht vollständig geladen werden.")
    for item in special.get("matches") or []:
        items[item["id"]] = item
    values = list(items.values())
    live = sorted((item for item in values if item["kind"] == "live"), key=lambda item: item["updatedAt"] or "", reverse=True)
    upcoming = sorted((item for item in values if item["kind"] == "upcoming"), key=lambda item: item["plannedAt"] or "")
    finals = sorted((item for item in values if item["kind"] == "final"), key=lambda item: item["updatedAt"] or "", reverse=True)
    pending = [item for item in values if item["kind"] == "pending"]
    ordered = live + upcoming + pending + finals
    return {"available": True, "stale": False, "specialEventsAvailable": True,
            "updatedAt": now.isoformat(), "items": ordered[:12]}


def get_darts_feed(now: datetime | None = None) -> dict:
    global _cache, _cache_time
    now = now or datetime.now(timezone.utc)
    collected = collected_snapshot("ticker", 360, now)
    if collected:
        return collected
    timestamp = now.timestamp()
    with _feed_load_lock:
        with _lock:
            if _cache and timestamp - _cache_time < CACHE_SECONDS:
                return _cache
        try:
            result = _load(now)
            with _lock:
                _cache, _cache_time = result, timestamp
            save_snapshot("ticker", result)
            return result
        except (requests.RequestException, ValueError, KeyError, TypeError, DartsFeedUnavailable) as exc:
            cached = _cache or load_snapshot("ticker")
            if cached:
                with _lock:
                    _cache = cached
                return last_known(cached)
            raise DartsFeedUnavailable("3K-Ergebnisse sind gerade nicht erreichbar.") from exc


def get_darts_center(league_key: str = "kl04", round_id: int | None = None, now: datetime | None = None) -> dict:
    """Load one league round for ClubIQ's native sports view using a strict allowlist."""
    global _center_cache
    league = next((item for item in LEAGUES if item["key"] == league_key), None)
    if not league:
        raise ValueError("Unbekannte Liga.")
    requested_round_id = round_id
    now = now or datetime.now(timezone.utc)
    collected = collected_snapshot(f"center:{league_key}:latest", 360, now)
    if collected and (round_id is None or collected.get("selectedRound", {}).get("id") == round_id):
        return collected
    session = PublicSession()
    session.headers.update({
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://portal.3k-darts.com",
        "Referer": "https://portal.3k-darts.com/",
    })
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
        matches = [_ticker_item(match, league["phase"], round_id, now) for match in raw_matches]
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
            "roundStatus": _round_status(allowed[round_id], raw_matches),
            "matches": matches,
            "barverMatches": barver_matches,
            "standings": _league_standings(league, all_matches),
            "events": [event for event in events if event["type"] != "leg"][:12],
            "pushEvents": events,
        }
        with _lock:
            _center_cache[cache_key] = (now.timestamp(), result)
        save_snapshot(f"center:{league_key}:{round_id}", result)
        if requested_round_id is None:
            save_snapshot(f"center:{league_key}:latest", result)
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
            return last_known(result)
        result = load_snapshot(f"center:{league_key}:{requested_round_id if requested_round_id is not None else 'latest'}")
        if result:
            return last_known(result)
        raise DartsFeedUnavailable("3K-Spieltag ist gerade nicht erreichbar.") from exc


def _public_get(url: str):
    response = source_recovery.get(
        lambda address, **options: scoped_get(requests.get, address, **options), url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://portal.3k-darts.com",
            "Referer": "https://portal.3k-darts.com/",
        },
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
    failed_events: list[int] = []
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
            # Retain the partial content, but never describe it as a complete source.
            failed_events.append(event_id)
            continue
    matches.sort(key=lambda item: (item.get("plannedAt") or item.get("updatedAt") or "", item["id"]))
    return {
        "available": not failed_events,
        "degraded": bool(failed_events),
        "updatedAt": now.isoformat(),
        "events": public_events,
        "matches": matches,
    }


def _get_special_events(now: datetime) -> dict:
    global _special_cache
    with _lock:
        cached = _special_cache
        if cached and now.timestamp() - cached[0] < SPECIAL_EVENTS_CACHE_SECONDS:
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


def _safe_venue(venue: dict) -> dict:
    return {
        "name": str(venue.get("name") or ""),
        "city": str(venue.get("locationCity") or ""),
        "postalCode": str(venue.get("locationPostalCode") or ""),
        "street": str(venue.get("locationStreet") or ""),
        "boards": venue.get("numberOfBoards") if isinstance(venue.get("numberOfBoards"), int) else None,
    }


def _load_home_venue(team_id: int, now: datetime) -> dict:
    with _lock:
        cached = _venue_cache.get(team_id)
    if cached and now.timestamp() - cached[0] < 3600:
        return cached[1]
    try:
        payload = _public_get(f"{FRONTEND_API}/participant/{team_id}")
        venue = _safe_venue(((payload.get("participant") or {}).get("teamSeason") or {}).get("playingVenue") or {})
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return cached[1] if cached else {}
    with _lock:
        _venue_cache[team_id] = (now.timestamp(), venue)
    return venue


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
        public_member = {
            "id": int(player_id) if isinstance(player_id, int) and player_id > 0 else None,
            "name": name[:100],
            "role": role,
        }
        gender = _public_gender(
            player.get("genderCd"), player.get("gender"),
            member.get("genderCd"), member.get("gender"),
            (member.get("member") or {}).get("genderCd"),
            (member.get("member") or {}).get("gender"),
        )
        if gender:
            public_member["gender"] = gender
        roster.append(public_member)
    role_order = {"Kapitän": 0, "Stellvertretung": 1, "Spieler": 2}
    roster.sort(key=lambda item: (role_order.get(item["role"], 3), item["name"]))
    safe_venue = _safe_venue(team.get("playingVenue") or {})
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
    # ClubIQ load responsive without flooding 3K's public service. A single
    # slow/broken 3K matchday must not take the whole ClubIQ season feed down.
    failed_round_ids: list[int] = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = {executor.submit(load_round, item): item for item in rounds}
        for job in as_completed(jobs):
            round_info = jobs[job]
            round_id = int(round_info.get("id") or 0)
            try:
                loaded_round_id, matches = job.result()
            except (requests.RequestException, ValueError, KeyError, TypeError):
                if round_id:
                    failed_round_ids.append(round_id)
                continue
            round_matches[loaded_round_id] = matches

    public_matches: list[dict] = []
    for round_info in rounds:
        for raw_match in round_matches.get(int(round_info.get("id") or 0), []):
            home_id, _ = _participant(raw_match, "Home")
            away_id, _ = _participant(raw_match, "Guest")
            if home_id in league["teams"] or away_id in league["teams"]:
                public_matches.append(_season_match(raw_match, league, round_info, now))

    public_matches.sort(key=lambda item: (item.get("plannedAt") or item.get("updatedAt") or "", item["id"]))
    loaded_rounds = [
        item for item in rounds
        if int(item.get("id") or 0) in round_matches
    ]
    selected = _preferred_round_by_matches(loaded_rounds or rounds, round_matches, now)
    selected_matches = round_matches.get(int((selected or {}).get("id") or 0), [])
    failed_round_ids.sort()
    degraded = bool(failed_round_ids)
    return {
        "league": _league_public(league),
        "rounds": [_safe_round(item) for item in rounds],
        "selectedRound": _safe_round(selected) if selected else None,
        "standings": _league_standings(league, selected_matches),
        "matches": public_matches,
        "degraded": degraded,
        "missingRoundIds": failed_round_ids,
        "loadedRoundCount": len(round_matches),
        "totalRoundCount": len(rounds),
        "warning": (
            f"{len(failed_round_ids)} Spieltag(e) konnten gerade nicht von 3K geladen werden."
            if degraded else None
        ),
    }


def _load_season(now: datetime) -> dict:
    leagues_by_key: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(LEAGUES)) as executor:
        jobs = {executor.submit(_load_league_season, league, now): league for league in LEAGUES}
        for job in as_completed(jobs):
            league = jobs[job]
            try:
                leagues_by_key[league["key"]] = job.result()
            except (requests.RequestException, ValueError, KeyError, TypeError, DartsFeedUnavailable):
                leagues_by_key[league["key"]] = {
                    "league": _league_public(league),
                    "rounds": [],
                    "selectedRound": None,
                    "standings": [],
                    "matches": [],
                    "degraded": True,
                    "missingRoundIds": [],
                    "loadedRoundCount": 0,
                    "totalRoundCount": 0,
                    "warning": "Diese Liga konnte gerade nicht vollständig von 3K geladen werden.",
                }
    leagues = [leagues_by_key[league["key"]] for league in LEAGUES]
    if all(item.get("degraded") and not item.get("rounds") for item in leagues):
        raise DartsFeedUnavailable("Keine Liga konnte von 3K geladen werden.")
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
    missing_profiles = []
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
                missing_profiles.append(code)
                profiles[code] = {"name": "", "roster": [], "venue": {}, "weekday": None, "throwoffTime": None}
    home_venues = {
        team_id: (profiles.get(code) or {}).get("venue") or {}
        for league in LEAGUES for team_id, code in league["teams"].items()
    }
    away_home_ids = {
        item.get("homeTeamId") for item in all_matches
        if item.get("kind") in {"upcoming", "live"}
        and item.get("homeTeamId") and item.get("homeTeamId") not in home_venues
    }
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = {executor.submit(_load_home_venue, team_id, now): team_id for team_id in away_home_ids}
        for job in as_completed(jobs):
            home_venues[jobs[job]] = job.result()
    for item in all_matches:
        item["homeVenue"] = home_venues.get(item.get("homeTeamId")) or {}
    teams = []
    for league in LEAGUES:
        for team_id, code in league["teams"].items():
            matches = [item for item in all_matches if code in (item.get("barverTeams") or [])]
            results = [item for item in matches if item["kind"] == "final"]
            upcoming = [item for item in matches if item["kind"] in {"upcoming", "live"}]
            standing = standings_by_id.get(team_id) or {}
            profile = profiles.get(code) or {}
            teams.append({
                "code": code,
                "id": team_id,
                "name": profile.get("name") or standing.get("name") or f"SV Barver Darts {code}",
                "league": _league_public(league),
                "rank": standing.get("rank"),
                "rankSource": standing.get("rankSource"),
                "nextMatch": upcoming[0] if upcoming else None,
                "lastMatch": results[-1] if results else None,
                "matches": matches,
                "record": _team_record(matches, code),
                "roster": profile.get("roster") or [],
                "venue": profile.get("venue") or {},
                "weekday": profile.get("weekday"),
                "throwoffTime": profile.get("throwoffTime"),
            })
    warnings = [
        {
            "league": item["league"]["key"],
            "missingRoundIds": item.get("missingRoundIds") or [],
            "message": item.get("warning"),
        }
        for item in leagues if item.get("degraded")
    ]
    if missing_profiles:
        warnings.append({"missingTeamProfiles": sorted(missing_profiles), "message": "Einzelne Mannschaftskader konnten gerade nicht geladen werden."})
    return {
        "available": True,
        "stale": False,
        "degraded": bool(warnings),
        "warnings": warnings,
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
    collected = collected_snapshot("season", 360, now)
    if collected:
        return collected
    with _lock:
        cached = _season_cache
        if cached:
            ttl = CACHE_SECONDS if cached[1].get("degraded") else SEASON_CACHE_SECONDS
            if now.timestamp() - cached[0] < ttl:
                return cached[1]
    with _season_load_lock:
        with _lock:
            cached = _season_cache
            if cached:
                ttl = CACHE_SECONDS if cached[1].get("degraded") else SEASON_CACHE_SECONDS
                if now.timestamp() - cached[0] < ttl:
                    return cached[1]
        try:
            result = _load_season(now)
            if result.get("degraded"):
                previous = (_season_cache or (0, None))[1] or load_snapshot("season")
                if previous:
                    return last_known(previous)
                result = {**result, "stale": True}
            with _lock:
                _season_cache = (now.timestamp(), result)
            save_snapshot("season", result)
            return result
        except (requests.RequestException, ValueError, KeyError, TypeError, DartsFeedUnavailable) as exc:
            with _lock:
                cached = _season_cache
            previous = cached[1] if cached else load_snapshot("season")
            if previous:
                return last_known(previous)
            raise DartsFeedUnavailable("Der 3K-Saisonspielplan ist gerade nicht erreichbar.") from exc


def _match_live_state(match: dict, now: datetime) -> tuple[dict, list[dict]]:
    group = darts_live_hub.get_group(str(match["id"]))
    if not group or group.get("stale") or group.get("retired"):
        return match, []
    boards = group.get("matches") or []
    recent = [board for board in boards
              if -5 <= now.timestamp() - (board.get("lastUpdateNs") or 0) / 1e9 < 600]
    evidence = [board for board in recent if board.get("active") or board.get("finished")]
    if not evidence:
        return match, []
    latest = max(evidence, key=lambda board: board.get("lastUpdateNs") or 0)
    home, away = latest.get("teamScoreHome"), latest.get("teamScoreGuest")
    if match.get("kind") == "final" and not group.get("finished"):
        return match, []
    match = {**match, "kind": "final" if group.get("finished") else "live"}
    if isinstance(home, int) and isinstance(away, int):
        match["score"] = f"{home}:{away}"
    games = [{
        "id": board["id"], "matchKey": board["matchKey"], "board": board.get("board"),
        "mode": board.get("mode"), "active": board.get("active"), "finished": board.get("finished"),
        "home": {"name": board["home"]["name"], "remaining": board["home"].get("points"),
                 "legs": board["home"].get("legs"), "average": board["home"].get("average")},
        "away": {"name": board["guest"]["name"], "remaining": board["guest"].get("points"),
                 "legs": board["guest"].get("legs"), "average": board["guest"].get("average")},
        "currentSide": "home" if board.get("currentPlayerIndex") == 0 else "away" if board.get("currentPlayerIndex") == 1 else None,
        "lastUpdated": board.get("lastUpdate"),
    } for board in recent if board.get("active") and not board.get("finished")]
    return match, games


def get_darts_match(match_id: int, now: datetime | None = None) -> dict:
    global _match_cache
    now = now or datetime.now(timezone.utc)
    season = get_darts_season(now)
    match = next((item for item in season.get("matches") or [] if item.get("id") == match_id), None)
    if not match:
        raise ValueError("Diese Begegnung gehört nicht zu einem freigegebenen Barver-Spielplan.")
    match, hub_games = _match_live_state(match, now)
    watching = _watch_live_candidate(match, now)
    ttl = CACHE_SECONDS if watching else SEASON_CACHE_SECONDS
    with _lock:
        cached = _match_cache.get(match_id)
        if cached and now.timestamp() - cached[0] < ttl:
            if watching and match["kind"] == "upcoming" and cached[1].get("match", {}).get("kind") in ("live", "final"):
                match = {**match, **cached[1]["match"]}
            result = {**cached[1], "match": match}
            if hub_games:
                result.update(liveGames=hub_games, reportAvailable=True, stale=False)
            return result
    event_id = int(match.get("eventId") or 0)
    if not event_id:
        league = next((item for item in LEAGUES if item["key"] == match.get("league")), None)
        event_id = int((league or {}).get("event") or 0)
    if not event_id:
        raise ValueError("Für diese Begegnung fehlt die 3K-Wettbewerbskennung.")
    summary = {
        "available": True, "stale": bool(season.get("stale")) and not bool(hub_games),
        "updatedAt": season.get("updatedAt"), "match": match,
        "games": [], "liveGames": hub_games, "performances": [],
        "reportAvailable": bool(hub_games), "sourceUrl": match.get("url"),
        "source": "last-known" if season.get("stale") else "3k",
    }
    if match["kind"] == "upcoming" and not watching:
        # A scheduled game is useful without an as-yet unpublished report.
        return summary
    try:
        report = _public_get(f"{API}/{event_id}/match/{match_id}/report")
        if not isinstance(report, list):
            report = []
        if match["kind"] in ("upcoming", "pending") and any(
            game.get("statusCd") in ("ACTIVE", "FINISH") for game in report
        ):
            finished = [game for game in report if game.get("statusCd") == "FINISH"]
            match = {**match, "kind": "final" if len(finished) == 12 else "live"}
            match["score"] = f"{sum((game.get('legsHome') or 0) > (game.get('legsAway') or 0) for game in finished)}:{sum((game.get('legsAway') or 0) > (game.get('legsHome') or 0) for game in finished)}"
        try:
            performance_payload = _public_get(f"{API}/{event_id}/performance/match/{match_id}?matchReport=1")
        except requests.RequestException:
            performance_payload = []
        performances = _performance_events(performance_payload, {"id": match_id}) if isinstance(performance_payload, list) else []
        live_games = hub_games
        if match["kind"] == "live" and not hub_games:
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
            "reportAvailable": bool(report or live_games),
        }
        with _lock:
            _match_cache[match_id] = (now.timestamp(), result)
        if result["reportAvailable"]:
            save_snapshot(f"match:{event_id}:{match_id}", result)
        return result
    except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
        with _lock:
            cached = _match_cache.get(match_id)
        previous = cached[1] if cached else load_snapshot(f"match:{event_id}:{match_id}")
        if previous:
            result = {**last_known(previous), "match": match}
            if hub_games:
                result.update(liveGames=hub_games, reportAvailable=True)
            return result
        return {**summary, "reportUnavailable": True}


def _player_names(value: str) -> list[str]:
    return [part.strip() for part in str(value or "").split(" & ") if part.strip()]


def _load_player_match_stats(event_id: int, match_id: int) -> tuple[list[dict], list[dict] | None]:
    key = (event_id, match_id)
    with _lock:
        cached = _player_match_stats_cache.get(key)
    if cached and 0 <= time.monotonic() - cached[0] < PLAYER_MATCH_STATS_CACHE_SECONDS:
        return cached[1]
    report = _public_get(f"{API}/{event_id}/match/{match_id}/report")
    if not isinstance(report, list) or not report:
        raise ValueError("Ungültiger 3K-Spielbericht")
    try:
        performances = _public_get(f"{API}/{event_id}/performance/match/{match_id}?matchReport=1")
    except (requests.RequestException, ValueError, KeyError, TypeError):
        performances = None
    if not isinstance(performances, list):
        performances = None
    # An unavailable performance source is unknown, rather than a confirmed empty
    # result. Retry it on the next collection; successful final reports also expire
    # so later corrections in 3K reach the site without restarting the worker.
    if performances is not None:
        with _lock:
            _player_match_stats_cache[key] = (time.monotonic(), (report, performances))
    return report, performances


def _stat_average(item: dict, score_key: str, darts_key: str) -> float | None:
    score, darts = item.get(score_key), item.get(darts_key)
    if not isinstance(score, (int, float)) or not isinstance(darts, (int, float)) or darts <= 0:
        return None
    return round(score * 3 / darts, 1)


def _official_league_player_stats() -> tuple[dict[tuple[str, str], dict], list[str]]:
    """Load 3K's official league statistics and keep only individual SV Barver players."""
    rows: dict[tuple[str, str], dict] = {}
    loaded_leagues: list[str] = []
    for league in LEAGUES:
        try:
            payload = _public_get(f"{API}/{league['event']}/statistics")
        except (requests.RequestException, ValueError, KeyError, TypeError):
            continue
        if not isinstance(payload, list):
            continue
        loaded_leagues.append(league["key"])
        allowed_codes = set(league["teams"].values())
        for item in payload:
            if not isinstance(item, dict):
                continue
            name = str(item.get("displayName") or "").strip()
            # 3K publishes doubles as separate rows ("A & B"). These are not player profiles.
            if not name or " & " in name:
                continue
            team_name = str((item.get("team") or {}).get("name") or "").strip()
            code = _barver_code_from_name(team_name)
            if code not in allowed_codes:
                continue
            if not isinstance(item.get("matchesTotal"), int) or item["matchesTotal"] < 0:
                continue
            matches_total = item.get("matchesTotal") if isinstance(item.get("matchesTotal"), int) else 0
            matches_won = item.get("matchesWon") if isinstance(item.get("matchesWon"), int) else 0
            matches_draw = item.get("matchesDraw") if isinstance(item.get("matchesDraw"), int) else 0
            rows[(code, name.casefold())] = {
                "average": _stat_average(item, "scoreTotal", "dartsTotal"),
                "average9": _stat_average(item, "scoreFirst9", "dartsFirst9"),
                "average12": _stat_average(item, "scoreFirst12", "dartsFirst12"),
                "average15": _stat_average(item, "scoreFirst15", "dartsFirst15"),
                "average18": _stat_average(item, "scoreFirst18", "dartsFirst18"),
                "gamesPlayed": matches_total,
                "gamesWon": matches_won,
                "gamesLost": max(0, matches_total - matches_won - matches_draw),
                "singlesPlayed": matches_total,
                "legsFor": item.get("legCount") if isinstance(item.get("legCount"), int) else 0,
                "legsAgainst": item.get("legCountOpponent") if isinstance(item.get("legCountOpponent"), int) else 0,
                "count180": item.get("count180") if isinstance(item.get("count180"), int) else 0,
                "count140Plus": sum(value for value in (item.get("count140"), item.get("count170")) if isinstance(value, int)),
                "count100Plus": sum(value for value in (item.get("count100"), item.get("count130")) if isinstance(value, int)),
                "count80Plus": sum(value for value in (item.get("count80"), item.get("count90")) if isinstance(value, int)),
                "highFinish": item.get("checkoutMax") if isinstance(item.get("checkoutMax"), int) and 2 <= item.get("checkoutMax") <= 170 else None,
                "statsSource": "3k",
                "league": league["key"],
            }
    return rows, loaded_leagues


def _load_player_stats(now: datetime) -> dict:
    season = get_darts_season(now)
    roster_by_name: dict[str, dict] = {}
    for team in season.get("teams") or []:
        for member in team.get("roster") or []:
            name = str(member.get("name") or "").strip()
            if name:
                roster_by_name[name.casefold()] = {
                    "id": member.get("id"), "name": name, "team": team.get("code")
                }

    stats: dict[str, dict] = {}
    for key, member in roster_by_name.items():
        player_id = member.get("id")
        if isinstance(player_id, int) and player_id > 0:
            stats[str(player_id)] = {
                **member, "gamesPlayed": 0, "gamesWon": 0, "gamesLost": 0,
                "legsFor": 0, "legsAgainst": 0, "singlesPlayed": 0,
                "average": None, "count180": 0, "highFinishes": 0,
                "highFinish": None, "playerNumber": "", "_score": 0, "_darts": 0,
            }

    def profile_for(name: str) -> dict | None:
        member = roster_by_name.get(name.casefold())
        return stats.get(str(member.get("id"))) if member else None

    finished = {
        (int(match.get("eventId") or 0), int(match.get("id") or 0))
        for match in season.get("matches") or []
        if match.get("kind") == "final" and match.get("eventId") and match.get("id")
    }
    loaded: list[tuple[list[dict], list[dict] | None]] = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = [executor.submit(_load_player_match_stats, event_id, match_id) for event_id, match_id in finished]
        for job in as_completed(jobs):
            try:
                loaded.append(job.result())
            except (requests.RequestException, ValueError, KeyError, TypeError):
                continue

    for report, performances in loaded:
        for game in report:
            if str(game.get("statusCd") or "").upper() != "FINISH":
                continue
            home = game.get("participantHome") or {}
            away = game.get("participantGuest") or {}
            home_legs, away_legs = game.get("legsHome"), game.get("legsAway")
            if not isinstance(home_legs, int) or not isinstance(away_legs, int):
                continue
            for participant, legs_for, legs_against in ((home, home_legs, away_legs), (away, away_legs, home_legs)):
                names = _player_names(participant.get("displayName"))
                for name in names:
                    player = profile_for(name)
                    if not player:
                        continue
                    player["gamesPlayed"] += 1
                    player["legsFor"] += legs_for
                    player["legsAgainst"] += legs_against
                    if legs_for > legs_against:
                        player["gamesWon"] += 1
                    elif legs_for < legs_against:
                        player["gamesLost"] += 1
                if len(names) == 1:
                    player = profile_for(names[0])
                    darts, score = participant.get("darts"), participant.get("score")
                    if player and isinstance(darts, (int, float)) and darts > 0 and isinstance(score, (int, float)):
                        player["singlesPlayed"] += 1
                        player["_darts"] += darts
                        player["_score"] += score

        for performance in performances or []:
            team_name = str((performance.get("team") or {}).get("name") or "")
            if not _barver_code_from_name(team_name):
                continue
            kind, value = performance.get("performanceTypeCd"), performance.get("value")
            count = performance.get("count") if isinstance(performance.get("count"), int) else 1
            for entry in performance.get("performancePlayers") or []:
                raw_player = entry.get("player") or {}
                name = str(raw_player.get("displayName") or raw_player.get("firstnameLastname") or "").strip()
                player = profile_for(name)
                if not player:
                    continue
                number = str(raw_player.get("playerNumber") or "").strip().upper()
                if number:
                    player["playerNumber"] = number[:12]
                if kind == "HS" and value == 180:
                    player["count180"] += max(1, count)
                elif kind == "HF" and isinstance(value, int) and 2 <= value <= 170:
                    player["highFinishes"] += max(1, count)
                    player["highFinish"] = max(player["highFinish"] or 0, value)

    for player in stats.values():
        darts = player.pop("_darts")
        score = player.pop("_score")
        player["average"] = round(score * 3 / darts, 1) if darts else None
        player["statsSource"] = "fallback"
        player["winRate"] = round(player["gamesWon"] * 100 / player["gamesPlayed"]) if player["gamesPlayed"] else None

    official_rows, official_leagues = _official_league_player_stats()
    for player in stats.values():
        official = official_rows.get((str(player.get("team") or ""), str(player.get("name") or "").casefold()))
        if not official:
            continue
        fallback_high_finishes = player.get("highFinishes", 0)
        fallback_player_number = player.get("playerNumber", "")
        player.update(official)
        # 3K's league statistics expose the highest checkout but not a reliable high-finish count.
        player["highFinishes"] = fallback_high_finishes
        player["playerNumber"] = fallback_player_number
        player["winRate"] = round(player["gamesWon"] * 100 / player["gamesPlayed"]) if player["gamesPlayed"] else None

    # Roster membership alone is not evidence of a zero-valued season statistic.
    stats = {key: player for key, player in stats.items()
             if player["gamesPlayed"] > 0 or player.get("statsSource") == "3k"}
    if not loaded and not official_leagues:
        raise DartsFeedUnavailable("Keine bestätigten 3K-Spielerstatistiken verfügbar.")
    performances_scanned = sum(performances is not None for _, performances in loaded)
    details_complete = len(loaded) == len(finished) and performances_scanned == len(finished)
    season_fresh = not season.get("stale") and not season.get("degraded") and season.get("available") is not False
    degraded = not season_fresh or not details_complete or (len(official_leagues) < len(LEAGUES) and not loaded)
    for player in stats.values():
        if not details_complete:
            # A partial count cannot safely replace a previously confirmed total.
            player["highFinishes"] = None
            player["playerNumber"] = ""
        player["statsUpdatedAt"] = now.isoformat()
        player["statsStale"] = degraded
    return {
        "available": True, "statsSchema": 1, "stale": degraded, "degraded": degraded, "updatedAt": now.isoformat(),
        "matchesScanned": len(loaded), "officialLeagues": official_leagues, "players": stats,
        "statsCoverage": {
            "observedAt": now.isoformat(), "seasonUpdatedAt": season.get("updatedAt"),
            "seasonFresh": season_fresh, "expectedMatches": len(finished),
            "reportsLoaded": len(loaded), "performancesLoaded": performances_scanned,
            "expectedLeagues": [league["key"] for league in LEAGUES],
            "officialLeaguesLoaded": official_leagues,
        },
    }


def get_darts_player_stats(now: datetime | None = None) -> dict:
    global _player_stats_cache, _player_stats_retry_at
    now = now or datetime.now(timezone.utc)
    collected = collected_snapshot("player-stats", 960, now)
    if collected:
        return collected
    with _lock:
        cached = _player_stats_cache
        if cached and cached[1].get("statsSchema") == 1 and now.timestamp() - cached[0] < PLAYER_STATS_CACHE_SECONDS:
            return cached[1]
    previous = cached[1] if cached and cached[1].get("statsSchema") == 1 else load_snapshot("player-stats")
    if previous and previous.get("statsSchema") != 1:
        previous = None
    if now.timestamp() < _player_stats_retry_at or not _player_stats_load_lock.acquire(blocking=False):
        if previous:
            return last_known(previous)
        raise DartsFeedUnavailable("Die 3K-Spielerstatistiken werden erneut geprüft.")
    try:
        result = _load_player_stats(now)
        if result.get("degraded"):
            _player_stats_retry_at = now.timestamp() + CACHE_SECONDS
            return last_known(previous) if previous else result
        with _lock:
            _player_stats_cache = (now.timestamp(), result)
            _player_stats_retry_at = 0
        save_snapshot("player-stats", result)
        return result
    except (requests.RequestException, ValueError, KeyError, TypeError, DartsFeedUnavailable) as exc:
        _player_stats_retry_at = now.timestamp() + CACHE_SECONDS
        if previous:
            return last_known(previous)
        raise DartsFeedUnavailable("Die 3K-Spielerstatistiken sind gerade nicht erreichbar.") from exc
    finally:
        _player_stats_load_lock.release()
