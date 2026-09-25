from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock

import requests


API = "https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend/event"
LEAGUES = (
    {"key": "kl04", "name": "Kreisligen 04", "short": "KL 04", "event": 1445, "phase": 2139, "teams": {174110, 174111, 174112}},
    {"key": "kk11", "name": "Kreisklasse 11", "short": "KK 11", "event": 1460, "phase": 2154, "teams": {174266}},
)
CACHE_SECONDS = 45
_cache: dict | None = None
_cache_time = 0.0
_lock = Lock()
_center_cache: dict[tuple[str, int], tuple[float, dict]] = {}


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
            _cache = _load(now)
            _cache_time = timestamp
            return _cache
        except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
            if _cache:
                return {**_cache, "stale": True}
            raise DartsFeedUnavailable("3K-Ergebnisse sind gerade nicht erreichbar.") from exc


def get_darts_center(league_key: str = "kl04", round_id: int | None = None, now: datetime | None = None) -> dict:
    """Load one league round for ClubIQ's native sports view using a strict allowlist."""
    global _center_cache
    league = next((item for item in LEAGUES if item["key"] == league_key), None)
    if not league:
        raise ValueError("Unbekannte Liga.")
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
            relevant = _relevant_rounds(rounds, now)
            chosen = relevant[-1] if relevant else (rounds[0] if rounds else None)
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
                report = session.get(f"{API}/{league['event']}/match/{match_id}/report", timeout=(3, 8))
                report_payload = _json(report) if report.ok else None
                if isinstance(report_payload, list):
                    events.extend(_game_events(report_payload, raw_match, barver_team, barver_side))
                    if item["kind"] == "live":
                        events.extend(_leg_events(report_payload, raw_match, barver_team))
        result = {
            "available": True,
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
        raise DartsFeedUnavailable("3K-Spieltag ist gerade nicht erreichbar.") from exc
