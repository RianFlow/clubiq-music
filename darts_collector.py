"""Independent, bounded collector for the existing normalized public darts data."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
from threading import Event
from time import monotonic

from darts_resilience import load_snapshot, snapshot_connection
from psycopg.types.json import Jsonb

DATASET = re.compile(r"^(season|ticker|player-stats|ranking|training-catalog|training:[1-9][0-9]{0,7}|center:(kl04|kk11):latest)$")


def stamp(value):
    if not isinstance(value, str):
        raise ValueError("Invalid observation time")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Observation time needs timezone")
    return parsed


def live_payload(payload):
    if payload.get("event", {}).get("status") in {"ACTIVE", "RUNNING", "STARTED"}:
        return True
    return any(isinstance(item, dict) and item.get("kind") == "live"
               for item in [*(payload.get("matches") or []), *(payload.get("items") or [])])


def official_table(rows):
    return bool(rows) and all(isinstance(row, dict) and row.get("rankSource") == "3k-placement"
                             and isinstance(row.get("rank"), int) and not isinstance(row["rank"], bool)
                             and row["rank"] > 0 for row in rows)


def verified_payload(key, payload, now):
    if not DATASET.fullmatch(key) or not isinstance(payload, dict):
        raise ValueError("Invalid dataset")
    if payload.get("available") is False or payload.get("stale") or payload.get("degraded"):
        raise ValueError("Incomplete source data")
    if key == "ticker" and not isinstance(payload.get("items"), list):
        raise ValueError("Invalid ticker")
    age = (now-stamp(payload.get("updatedAt"))).total_seconds()
    if not -30 <= age <= 180:
        raise ValueError("Cached answer is not a new source observation")
    if key == "season":
        teams, leagues = payload.get("teams") or [], payload.get("leagues") or []
        if len(teams) != 4 or {team.get("code") for team in teams} != {"A","B","C","D"} or not payload.get("matches"):
            raise ValueError("Incomplete season")
        if len(leagues) != 2 or {item.get("league",{}).get("key") for item in leagues} != {"kl04","kk11"}:
            raise ValueError("Incomplete season leagues")
        if payload.get("warnings") or payload.get("specialEventsAvailable") is not True:
            raise ValueError("Incomplete season sources")
        if any(item.get("degraded") or item.get("missingRoundIds") or not item.get("totalRoundCount")
               or item.get("loadedRoundCount") != item["totalRoundCount"]
               or not official_table(item.get("standings")) for item in leagues):
            raise ValueError("Incomplete season rounds or official tables")
    if key.startswith("center:") and (payload.get("league", {}).get("key") != key.split(":")[1] or not payload.get("standings") or not payload.get("selectedRound", {}).get("id")):
        raise ValueError("Wrong or incomplete league")
    if key.startswith("center:") and not official_table(payload["standings"]):
        raise ValueError("Official table unavailable")
    if key == "player-stats" and (payload.get("statsSchema") != 1 or not payload.get("players")):
        raise ValueError("Incomplete player statistics")
    if key == "player-stats" and any(player.get("statsStale") for player in payload["players"].values()):
        raise ValueError("Stale player statistics")
    if key == "training-catalog" and not payload.get("events"):
        raise ValueError("Empty training catalog")
    if key == "ranking" and (not payload.get("events") or not payload.get("rows")):
        raise ValueError("Incomplete ranking")
    if key.startswith("training:") and payload.get("event", {}).get("id") != int(key.split(":")[1]):
        raise ValueError("Wrong training")
    if key.startswith("training:") and int(key.split(":")[1]) > 10000000:
        raise ValueError("Invalid training identifier")
    if key.startswith("training:") and (payload.get("performancesUnavailable") or payload.get("placementsUnavailable")):
        raise ValueError("Incomplete training details")
    # A single canonical format also makes comparisons independent of input offsets.
    return {**payload, "updatedAt":stamp(payload["updatedAt"]).astimezone(timezone.utc).isoformat(),
            "sourceConnection":"collector", "collectorObservedAt":now.isoformat()}


def persist_dataset(key, payload):
    """A separate namespace keeps the optional integration reversible."""
    with snapshot_connection() as conn, conn.cursor() as cursor:
        cursor.execute("""
            INSERT INTO darts_feed_snapshots (cache_key,payload,observed_at)
            VALUES (%s,%s,%s)
            ON CONFLICT (cache_key) DO UPDATE SET
              payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at
            WHERE EXCLUDED.observed_at >= darts_feed_snapshots.observed_at
        """, ("collector:"+key, Jsonb(payload), payload["updatedAt"]))


def collected_snapshot(key, max_age, now=None):
    """Opt-in readers never perform an upstream request or pretend old data is new."""
    if os.getenv("DARTS_COLLECTOR_READ_ENABLED") != "1" or not DATASET.fullmatch(key):
        return None
    payload = load_snapshot("collector:"+key)
    if not payload or payload.get("sourceConnection") != "collector":
        return None
    now = now or datetime.now(timezone.utc)
    try:
        age = (now-stamp(payload.get("updatedAt"))).total_seconds()
    except (ValueError, TypeError):
        return None
    if age < -30:
        return None
    if live_payload(payload):
        max_age = min(max_age, 120)
    if age > max_age:
        stale = {**payload, "stale":True, "recovery":"automatic", "source":"last-known"}
        if key.startswith("training:"):
            stale["source"] = payload.get("source")
        if key == "player-stats":
            stale["players"] = {identifier:{**player,"statsStale":True} for identifier,player in payload.get("players",{}).items()}
        return stale
    return payload


class Collector:
    def __init__(self, tasks, persist=persist_dataset, clock=monotonic, now=lambda:datetime.now(timezone.utc)):
        self.tasks = tasks
        self.persist = persist
        self.clock = clock
        self.now = now
        self.started = now().isoformat()
        self.states = {name:{"lastAttempt":None,"lastSuccess":None,"dataUpdatedAt":None,"error":None,"failures":0,"next":0,"refreshEverySeconds":interval} for name,(interval,_) in tasks.items()}

    def cycle(self):
        for name, (interval, loader) in self.tasks.items():
            state = self.states[name]
            if self.clock() < state["next"]:
                continue
            state["lastAttempt"] = self.now().isoformat()
            try:
                results = loader()
                if not results:
                    raise ValueError("No verified dataset")
                validated = [(key, verified_payload(key, payload, self.now())) for key,payload in results]
                for key,payload in validated:
                    self.persist(key, payload)
                state.update(lastSuccess=self.now().isoformat(),dataUpdatedAt=min(p["updatedAt"] for _,p in validated),error=None,failures=0)
                delay = min(interval, 60) if any(live_payload(p) for _,p in validated) else interval
                state["refreshEverySeconds"] = delay
            except Exception as error:
                # Exception messages may contain connection strings; publish type only.
                state.update(error=type(error).__name__,failures=state["failures"]+1)
                delay = (30,60,120,300)[min(state["failures"]-1,3)]
            state["next"] = self.clock()+delay
        return self.status()

    def status(self):
        now = self.now()
        datasets = {}
        for name,(interval,_) in self.tasks.items():
            state = self.states[name]
            fresh = False
            if state["dataUpdatedAt"] and not state["error"]:
                fresh = (now-stamp(state["dataUpdatedAt"])).total_seconds() <= state["refreshEverySeconds"]+60
            datasets[name] = {k:v for k,v in state.items() if k != "next"}
            datasets[name].update(fresh=fresh,nextAttemptInSeconds=max(0,int(state["next"]-self.clock())))
        return {"startedAt":self.started,"heartbeatAt":now.isoformat(),"allSourcesFresh":bool(datasets) and all(v["fresh"] for v in datasets.values()),"datasets":datasets}


def tasks():
    # Imported only by the executable worker, avoiding circular imports in API readers.
    import darts_feed as feed
    import darts_training as training
    import darts_ranking as ranking

    def season():
        result = feed._load_season(datetime.now(timezone.utc))
        if not result.get("degraded"):
            with feed._lock:
                feed._season_cache = (datetime.now(timezone.utc).timestamp(),result)
        return [("season",result)]

    def event():
        catalog = training.get_trainings()
        event_id = catalog.get("selectedId")
        if not event_id:
            return []
        # Explicit collection must not only return the event's visitor cache.
        training._event_cache.pop(event_id,None)
        return [(f"training:{event_id}",training.get_training(event_id))]

    return {
        "season":(300,season),
        "center-kl04":(300,lambda:[("center:kl04:latest",feed.get_darts_center("kl04"))]),
        "center-kk11":(300,lambda:[("center:kk11:latest",feed.get_darts_center("kk11"))]),
        "ticker":(300,lambda:[("ticker",feed._load(datetime.now(timezone.utc)))]),
        "player-stats":(900,lambda:[("player-stats",feed._load_player_stats(datetime.now(timezone.utc)))]),
        "ranking":(600,lambda:[("ranking",ranking._sanitize(ranking._public_get(f"{ranking.API}/ranking?mandantKey=1931&tournamentSeriesId=1282&withEventDetails=1"),datetime.now(timezone.utc)))]),
        "training-catalog":(300,lambda:[("training-catalog",training.get_trainings(force=True))]),
        "training":(300,event),
    }


def write_status(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once",action="store_true")
    parser.add_argument("--dry-run",action="store_true",help="Collect without writing any database data")
    parser.add_argument("--only",choices=list(tasks()))
    parser.add_argument("--status-file",default="/tmp/darts-collector-status.json")
    args = parser.parse_args()
    # The collector always checks the source; only the separate API opts into reads.
    os.environ.pop("DARTS_COLLECTOR_READ_ENABLED",None)
    # Existing loaders also save visitor snapshots. The worker only writes through
    # its strict writer; dry-run must never change even those implicit snapshots.
    os.environ["DARTS_SNAPSHOT_WRITES_DISABLED"] = "1"
    selected = tasks()
    if args.only:
        selected = {args.only:selected[args.only]}
    def capture(key,payload):
        pass
    collector = Collector(selected,persist=capture if args.dry_run else persist_dataset)
    stop = Event()
    for number in (signal.SIGTERM,signal.SIGINT):
        signal.signal(number,lambda *_:stop.set())
    last_attempts = None
    while not stop.is_set():
        status = collector.cycle()
        status["mode"] = "dry-run" if args.dry_run else "write"
        write_status(args.status_file,status)
        attempts = [state["lastAttempt"] for state in status["datasets"].values()]
        if args.once or attempts != last_attempts:
            print(json.dumps(status,ensure_ascii=False),flush=True)
            last_attempts = attempts
        if args.once:
            return 0 if status["allSourcesFresh"] else 2
        stop.wait(5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
