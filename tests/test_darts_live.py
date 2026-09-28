import unittest
from datetime import datetime, timezone

from darts_live import DartsLiveHub, _watch_live_candidate, detect_events, normalize_match, normalize_rest, timestamp_ns


def raw_match(match_key="1657291", board="2", stamp="2026-09-27T13:35:52.718986398", **changes):
    value = {
        "id": 7801628, "matchKey": match_key, "database": "10", "groupKey": "1657285",
        "groupName": "VFL Emslage 1 - SV Barver Darts 2", "board": board,
        "currentplayerIndex": 0, "mode": "Best of 5 Legs", "setsHome": 5, "setsGuest": 0,
        "legsHome": 15, "legsGuest": 5, "status": 1, "statusActive": True,
        "statusFinished": False, "lastUpdate": stamp, "allInOneMatchdata": "private history",
        "matchPlayers": [
            {"id": 1, "index": 0, "playerName": "T. Dreyer & D. Laarmann", "points": 168, "lastScore": 57, "darts": 12, "legs": 2, "count180": 0, "highfinish": 40, "scoreTotal": 2257, "dartsTotal": 104, "email": "hidden@example.test"},
            {"id": 2, "index": 1, "playerName": "R. Tiedemann & J. Renzelmann", "points": 116, "lastScore": 140, "darts": 12, "legs": 2, "count180": 0, "highfinish": 36, "scoreTotal": 2340, "dartsTotal": 104},
        ],
    }
    value.update(changes)
    return value


META = {"id": 1657285, "home": "VFL Emslage 1", "away": "SV Barver Darts 2", "barverTeams": ["B"], "barverSides": {"B": "away"}}


class DartsLiveTests(unittest.TestCase):
    def test_nanosecond_timestamp_order_is_preserved(self):
        self.assertLess(timestamp_ns("2026-09-27T13:35:52.718986397"), timestamp_ns("2026-09-27T13:35:52.718986398"))
        self.assertEqual(timestamp_ns("invalid"), 0)

    def test_mapper_whitelists_and_calculates_average(self):
        mapped = normalize_match(raw_match())
        self.assertEqual((mapped["groupKey"], mapped["board"], mapped["guest"]["points"]), ("1657285", "2", 116))
        self.assertEqual(mapped["guest"]["average"], 67.5)
        self.assertNotIn("allInOneMatchdata", str(mapped))
        self.assertNotIn("hidden@example.test", str(mapped))

    def test_rest_keeps_all_parallel_boards(self):
        matches = normalize_rest({"data": [raw_match("board-1", "1"), raw_match("board-2", "2")]})
        self.assertEqual([(item["matchKey"], item["board"]) for item in matches], [("board-1", "1"), ("board-2", "2")])

    def test_transition_detects_only_barver_events(self):
        before = normalize_match(raw_match())
        updated_players = [dict(player) for player in raw_match()["matchPlayers"]]
        updated_players[1].update({"legs": 3, "count180": 1, "highfinish": 121})
        after = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000001", matchPlayers=updated_players))
        events = detect_events(before, after, META)
        self.assertEqual({event["type"] for event in events}, {"leg", "180", "high_finish"})
        self.assertTrue(all(event["team"] == "SV Barver Darts B" for event in events))

    def test_hub_rejects_stale_and_broadcasts_new_state(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        newer = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000002"))
        older = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000001", board="9"))
        self.assertTrue(hub.apply("1657285", [newer], "rest"))
        self.assertFalse(hub.apply("1657285", [older], "stomp"))
        self.assertEqual(hub.get_group("1657285")["matches"][0]["board"], "2")

    def test_upcoming_match_is_watched_around_planned_start(self):
        now = datetime(2026, 9, 28, 18, 0, tzinfo=timezone.utc)
        match = {**META, "kind": "upcoming", "plannedAt": "2026-09-28T17:30:00+00:00"}
        self.assertTrue(_watch_live_candidate(match, now))

    def test_distant_upcoming_match_is_not_watched(self):
        now = datetime(2026, 9, 28, 18, 0, tzinfo=timezone.utc)
        future = {**META, "kind": "upcoming", "plannedAt": "2026-10-02T17:30:00+00:00"}
        old = {**META, "kind": "upcoming", "plannedAt": "2026-09-28T08:00:00+00:00"}
        self.assertFalse(_watch_live_candidate(future, now))
        self.assertFalse(_watch_live_candidate(old, now))

    def test_reconcile_starts_connector_for_upcoming_match_in_live_window(self):
        created = []

        class FakeConnector:
            def __init__(self, hub, database, group_key):
                created.append(group_key)
            def start(self):
                pass
            def stop(self):
                pass

        hub = DartsLiveHub(FakeConnector)
        match = {**META, "kind": "upcoming", "plannedAt": datetime.now(timezone.utc).isoformat()}
        hub.reconcile([match])
        self.assertEqual(created, ["1657285"])

    def test_group_stays_open_between_finished_board_blocks(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        first = normalize_match(raw_match(
            "block-1-board-1", "1", "2026-09-27T13:35:53.000000001",
            setsHome=5, setsGuest=1, status=2, statusActive=False, statusFinished=True,
        ))
        second = normalize_match(raw_match(
            "block-1-board-2", "2", "2026-09-27T13:35:53.000000002",
            setsHome=5, setsGuest=1, status=2, statusActive=False, statusFinished=True,
        ))
        hub.apply("1657285", [first, second], "rest")
        self.assertFalse(hub.group_finished("1657285"))

    def test_group_finishes_at_twelve_team_games(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        final = normalize_match(raw_match(
            "final-board", "1", "2026-09-27T13:35:53.000000003",
            setsHome=8, setsGuest=4, status=2, statusActive=False, statusFinished=True,
        ))
        hub.apply("1657285", [final], "rest")
        self.assertTrue(hub.group_finished("1657285"))

    def test_reconcile_starts_only_one_connector_per_live_group(self):
        created = []

        class FakeConnector:
            def __init__(self, hub, database, group_key):
                created.append(group_key)
            def start(self):
                pass
            def stop(self):
                pass

        hub = DartsLiveHub(FakeConnector)
        match = {**META, "kind": "live", "barverTeam": "B", "league": "cup"}
        hub.reconcile([match, match])
        self.assertEqual(created, ["1657285"])


if __name__ == "__main__":
    unittest.main()
