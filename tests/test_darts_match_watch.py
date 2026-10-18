import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone

from darts_live import DartsLiveHub, normalize_match
from darts_match_watch import TeamMatchWatch
from darts_push import barver_push_event, subscription_matches
from test_darts_live import raw_match


class Connector:
    def __init__(self, hub, database, key):
        self.key, self.stopped = key, False
    def start(self):
        pass
    def stop(self):
        self.stopped = True


class MatchWatchTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.fixture = {"id": 1657285, "home": "Gäste", "away": "SV Barver Darts B", "barverTeams": ["B"],
                        "barverSides": {"B": "away"}, "kind": "upcoming", "plannedAt": self.now.isoformat()}
        self.source = {"matches": [self.fixture]}
        self.saved = None
        self.loads = 0
        self.hub = DartsLiveHub(Connector)
        self.watch = self.make_watch(self.hub)

    def make_watch(self, hub):
        def load():
            self.loads += 1
            if isinstance(self.source, Exception):
                raise self.source
            return deepcopy(self.source)
        def save(value):
            self.saved = deepcopy(value)
        return TeamMatchWatch(hub, load, lambda: deepcopy(self.saved), save, lambda: self.now)

    def advance(self, seconds=31):
        self.now += timedelta(seconds=seconds)
        self.watch.poll()

    def board(self, home=0, away=0, darts=0):
        players = [dict(player, legs=0, darts=darts, points=501, count180=0, highfinish=0)
                   for player in raw_match()["matchPlayers"]]
        return normalize_match(raw_match(stamp=self.now.isoformat(), setsHome=home, setsGuest=away, matchPlayers=players))

    def test_runs_without_visitors_and_missing_fixture_does_not_stop_connector(self):
        self.watch.poll()
        connector = self.hub._connectors["1657285"]
        self.source = {"matches": []}
        self.advance()
        self.assertIs(self.hub._connectors["1657285"], connector)
        self.assertFalse(connector.stopped)
        self.assertEqual(self.hub.get_group("1657285")["watchState"], "waiting")
        self.assertEqual(self.watch.overlay({"items": []}, "items")["items"][0]["kind"], "upcoming")

    def test_source_failure_keeps_known_game_and_other_teams(self):
        a = {**self.fixture, "id": 100, "home": "SV Barver Darts A", "barverTeams": ["A"]}
        self.source["matches"].append(a)
        self.watch.poll()
        self.source = RuntimeError("upstream unavailable")
        self.advance()
        self.assertEqual(set(self.hub._connectors), {"100", "1657285"})
        self.assertEqual(len(self.watch.status()["teams"]), 4)
        self.assertEqual(self.watch.status()["error"], "RuntimeError")

    def test_reschedule_retires_old_watch_and_honors_new_appointment(self):
        self.watch.poll()
        self.source["matches"][0]["plannedAt"] = (self.now + timedelta(days=7)).isoformat()
        self.advance()
        self.assertFalse(self.hub._connectors)
        self.assertEqual(self.watch.status()["teams"][1]["state"], "upcoming")

    def test_no_start_push_from_countdown_or_coming_soon_board(self):
        self.watch.poll()
        self.assertEqual(self.hub.drain_events(), [])
        board = {**self.board(), "active": False, "comingSoon": True}
        self.hub.apply("1657285", [board], "rest")
        self.advance()
        self.assertEqual(self.hub.drain_events(), [])
        self.assertFalse(self.watch.entries["1657285"].get("startHandled"))

    def test_start_push_once_and_same_identity_after_restart(self):
        self.watch.poll()
        self.hub.apply("1657285", [self.board()], "rest")
        self.watch.poll()
        events = self.hub.drain_events()
        self.assertEqual([event["type"] for event in events], ["match_start"])
        event = barver_push_event("live", events[0])
        self.assertEqual(event["event_id"], barver_push_event("kl04", events[0])["event_id"])
        self.assertIn("/app/?match=1657285", event["url"])
        self.assertTrue(subscription_matches(event, ["B"], [], ["match_start"]))
        self.assertFalse(subscription_matches(event, ["A"], [], ["match_start"]))
        self.assertFalse(subscription_matches(event, ["B"], [], ["match"]))
        restored = DartsLiveHub(Connector)
        self.make_watch(restored).poll()
        self.assertEqual(restored.drain_events(), [])
        self.assertTrue(restored.get_group("1657285")["matches"])

    def test_first_observation_midgame_or_stale_board_does_not_announce_start(self):
        for board in (self.board(home=2, away=1), {**self.board(), "lastUpdateNs": int((self.now.timestamp()-1000)*1e9)}):
            self.setUp()
            self.watch.poll()
            self.hub.apply("1657285", [board], "rest")
            self.watch.poll()
            self.assertEqual(self.hub.drain_events(), [])

    def test_clinch_keeps_live_and_full_finish_has_fixed_ten_minute_recap(self):
        self.watch.poll()
        self.hub.apply("1657285", [self.board(home=1, away=7)], "rest")
        self.watch.poll()
        self.assertEqual(self.watch.status()["teams"][1]["state"], "live")
        self.assertIsNone(self.hub.get_group("1657285").get("summaryUntil"))
        self.now += timedelta(seconds=1)
        self.hub.apply("1657285", [self.board(home=4, away=8)], "rest")
        self.watch.poll()
        group = self.hub.get_group("1657285")
        until = datetime.fromisoformat(group["summaryUntil"])
        self.assertAlmostEqual((until-self.now).total_seconds(), 600, places=2)
        self.assertEqual(self.watch.overlay({"matches": []})["matches"][0]["kind"], "final")
        self.now += timedelta(seconds=120)
        restored = DartsLiveHub(Connector)
        second_watch = self.make_watch(restored)
        second_watch.poll()
        self.assertEqual(restored.get_group("1657285")["summaryUntil"], group["summaryUntil"])
        self.now += timedelta(seconds=481)
        second_watch.poll()
        self.assertEqual(second_watch.overlay({"matches": []})["matches"], [])

    def test_normal_days_do_not_refresh_the_schedule_every_ten_seconds(self):
        self.fixture["plannedAt"] = (self.now + timedelta(days=2)).isoformat()
        self.watch.poll()
        self.advance(10)
        self.assertEqual(self.loads, 1)
        self.advance(291)
        self.assertEqual(self.loads, 2)

    def test_stale_final_cannot_stop_an_active_game(self):
        self.watch.poll()
        self.source = {"stale": True, "matches": [{**self.fixture, "kind": "final", "score": "8:4"}]}
        self.advance()
        self.assertFalse(self.hub.group_finished("1657285"))
        self.assertIn("1657285", self.hub._connectors)

    def test_official_final_score_wins_over_an_incomplete_live_snapshot(self):
        self.watch.poll()
        self.hub.apply("1657285", [self.board(home=4, away=5)], "rest")
        self.source = {"matches": [{**self.fixture, "kind": "final", "score": "4:8", "updatedAt": self.now.isoformat()}]}
        self.advance()
        self.assertEqual(self.watch.overlay({"matches": []})["matches"][0]["score"], "4:8")

    def test_waiting_watcher_announces_delayed_first_board_during_first_leg(self):
        self.watch.poll()
        board = self.board(darts=12)
        self.hub.apply("1657285", [board], "rest")
        self.watch.poll()
        self.assertEqual([event["type"] for event in self.hub.drain_events()], ["match_start"])

    def test_expired_summary_does_not_return_from_an_outdated_upcoming_fixture(self):
        self.watch.poll()
        self.hub.apply("1657285", [self.board(home=4, away=8)], "rest")
        self.watch.poll()
        self.advance(601)
        self.advance()
        self.assertEqual(self.watch.status()["teams"][1]["state"], "idle")


if __name__ == "__main__":
    unittest.main()
