import unittest
from datetime import datetime, timezone
from unittest.mock import patch
import requests

import darts_feed


class DartsPlayerStatsTests(unittest.TestCase):
    def setUp(self):
        darts_feed._player_stats_cache = None
        darts_feed._player_stats_retry_at = 0
        darts_feed._player_match_stats_cache.clear()

    def test_source_failure_does_not_publish_roster_as_fresh_zeroes(self):
        season = {"teams": [{"code": "A", "roster": [{"id": 1, "name": "Spieler"}]}], "matches": []}
        with patch.object(darts_feed, "get_darts_season", return_value=season), \
             patch.object(darts_feed, "_official_league_player_stats", return_value=({}, [])):
            with self.assertRaises(darts_feed.DartsFeedUnavailable):
                darts_feed._load_player_stats(datetime.now(timezone.utc))

    def test_unverified_roster_players_are_omitted(self):
        season = {"teams": [{"code": "A", "roster": [{"id": 1, "name": "Spieler"}]}], "matches": []}
        with patch.object(darts_feed, "get_darts_season", return_value=season), \
             patch.object(darts_feed, "_official_league_player_stats", return_value=({}, ["kl04", "kk11"])):
            result = darts_feed._load_player_stats(datetime.now(timezone.utc))
        self.assertEqual(result["players"], {})
        self.assertFalse(result["stale"])

    def test_restart_restores_confirmed_snapshot_and_limits_failed_retries(self):
        now = datetime(2026, 10, 6, tzinfo=timezone.utc)
        saved = {"statsSchema": 1, "updatedAt": "2026-10-05T12:00:00+00:00", "players": {"1": {"average": 65.9}}}
        with patch.object(darts_feed, "load_snapshot", return_value=saved), \
             patch.object(darts_feed, "_load_player_stats", side_effect=requests.RequestException()) as load, \
             patch.object(darts_feed, "save_snapshot") as save:
            for _ in range(3):
                result = darts_feed.get_darts_player_stats(now)
                self.assertTrue(result["stale"])
                self.assertEqual(result["updatedAt"], saved["updatedAt"])
                self.assertEqual(result["players"]["1"]["average"], 65.9)
            self.assertEqual(load.call_count, 1)
            save.assert_not_called()

    def test_partial_result_does_not_overwrite_confirmed_snapshot(self):
        saved = {"statsSchema": 1, "updatedAt": "2026-10-05T12:00:00+00:00", "players": {"1": {"average": 65.9}}}
        with patch.object(darts_feed, "load_snapshot", return_value=saved), \
             patch.object(darts_feed, "_load_player_stats", return_value={"statsSchema": 1, "degraded": True, "players": {}}), \
             patch.object(darts_feed, "save_snapshot") as save:
            result = darts_feed.get_darts_player_stats()
        self.assertEqual(result["players"], saved["players"])
        self.assertTrue(result["stale"])
        save.assert_not_called()

    def test_parallel_reader_uses_saved_snapshot_without_waiting(self):
        saved = {"statsSchema": 1, "updatedAt": "2026-10-05T12:00:00+00:00", "players": {}}
        darts_feed._player_stats_load_lock.acquire()
        try:
            with patch.object(darts_feed, "load_snapshot", return_value=saved), \
                 patch.object(darts_feed, "_load_player_stats") as load:
                result = darts_feed.get_darts_player_stats()
                self.assertTrue(result["stale"])
                load.assert_not_called()
        finally:
            darts_feed._player_stats_load_lock.release()

    def test_success_saves_normalized_stats(self):
        good = {"statsSchema": 1, "updatedAt": "2026-10-06T12:00:00+00:00", "players": {"1": {"average": 65.9}}}
        with patch.object(darts_feed, "load_snapshot", return_value=None), \
             patch.object(darts_feed, "_load_player_stats", return_value=good) as load, \
             patch.object(darts_feed, "save_snapshot") as save:
            self.assertEqual(darts_feed.get_darts_player_stats(), good)
            self.assertEqual(darts_feed.get_darts_player_stats(), good)
            self.assertEqual(load.call_count, 1)
            save.assert_called_once_with("player-stats", good)

    def test_invalid_report_is_not_cached_as_empty_success(self):
        with patch.object(darts_feed, "_public_get", return_value={}):
            with self.assertRaises(ValueError):
                darts_feed._load_player_match_stats(1445, 99)
        self.assertNotIn((1445, 99), darts_feed._player_match_stats_cache)

    def test_rolls_up_public_report_and_performances_by_roster_name(self):
        season = {
            "teams": [{"code": "A", "roster": [{"id": 89027, "name": "Jannik Kläning"}]}],
            "matches": [{"id": 1280523, "eventId": 1445, "kind": "final"}],
        }
        report = [{
            "statusCd": "FINISH", "legsHome": 3, "legsAway": 2,
            "participantHome": {"displayName": "Jannik Kläning", "darts": 122, "score": 2480},
            "participantGuest": {"displayName": "Gegner Eins", "darts": 122, "score": 2140},
        }]
        performances = [
            {"performanceTypeCd": "HS", "value": 180, "count": 2, "team": {"name": "SV Barver Darts A"},
             "performancePlayers": [{"player": {"displayName": "Jannik Kläning", "playerNumber": "WTDU"}}]},
            {"performanceTypeCd": "HF", "value": 121, "count": 1, "team": {"name": "SV Barver Darts A"},
             "performancePlayers": [{"player": {"displayName": "Jannik Kläning"}}]},
        ]
        with patch.object(darts_feed, "get_darts_season", return_value=season), \
             patch.object(darts_feed, "_load_player_match_stats", return_value=(report, performances)), \
             patch.object(darts_feed, "_official_league_player_stats", return_value=({}, [])):
            result = darts_feed._load_player_stats(datetime(2026, 9, 27, tzinfo=timezone.utc))

        player = result["players"]["89027"]
        self.assertEqual(player["average"], 61.0)
        self.assertEqual(player["gamesPlayed"], 1)
        self.assertEqual(player["gamesWon"], 1)
        self.assertEqual(player["legsFor"], 3)
        self.assertEqual(player["legsAgainst"], 2)
        self.assertEqual(player["count180"], 2)
        self.assertEqual(player["highFinishes"], 1)
        self.assertEqual(player["highFinish"], 121)
        self.assertEqual(player["playerNumber"], "WTDU")
        self.assertEqual(result["matchesScanned"], 1)

    def test_official_3k_stats_override_fallback_for_roster_player(self):
        season = {
            "teams": [{"code": "A", "roster": [{"id": 89027, "name": "Jannik Kläning"}]}],
            "matches": [],
        }
        official = {("A", "jannik kläning"): {
            "average": 65.9, "average9": 76.6, "average12": 73.2, "average15": 74.9, "average18": 72.5,
            "gamesPlayed": 6, "gamesWon": 6, "gamesLost": 0, "singlesPlayed": 6,
            "legsFor": 18, "legsAgainst": 5, "count180": 3, "count140Plus": 11,
            "count100Plus": 29, "count80Plus": 14, "highFinish": 91,
            "statsSource": "3k", "league": "kl04",
        }}
        with patch.object(darts_feed, "get_darts_season", return_value=season), \
             patch.object(darts_feed, "_official_league_player_stats", return_value=(official, ["kl04"])):
            result = darts_feed._load_player_stats(datetime(2026, 9, 28, tzinfo=timezone.utc))

        player = result["players"]["89027"]
        self.assertEqual(player["average"], 65.9)
        self.assertEqual(player["gamesPlayed"], 6)
        self.assertEqual(player["gamesWon"], 6)
        self.assertEqual(player["count180"], 3)
        self.assertEqual(player["highFinish"], 91)
        self.assertEqual(player["statsSource"], "3k")
        self.assertEqual(result["officialLeagues"], ["kl04"])

    def test_official_endpoint_ignores_doubles_and_non_barver_rows(self):
        payload = [
            {"displayName": "Jannik Kläning", "scoreTotal": 11421, "dartsTotal": 520, "matchesTotal": 6, "matchesWon": 6,
             "matchesDraw": 0, "legCount": 18, "legCountOpponent": 5, "count180": 3, "count140": 11, "count170": 0,
             "count100": 27, "count130": 2, "count80": 8, "count90": 6, "checkoutMax": 91,
             "team": {"name": "SV Barver Darts A"}},
            {"displayName": "Christian Fecht & Jannik Kläning", "scoreTotal": 7642, "dartsTotal": 349,
             "team": {"name": "SV Barver Darts A"}},
            {"displayName": "Gegner Eins", "scoreTotal": 6000, "dartsTotal": 300,
             "team": {"name": "OSC Damme C"}},
        ]
        def fake_get(url):
            return payload if "/1445/statistics" in url else []

        with patch.object(darts_feed, "_public_get", side_effect=fake_get):
            rows, leagues = darts_feed._official_league_player_stats()

        self.assertIn(("A", "jannik kläning"), rows)
        self.assertNotIn(("A", "christian fecht & jannik kläning"), rows)
        self.assertEqual(rows[("A", "jannik kläning")]["average"], 65.9)
        self.assertEqual(rows[("A", "jannik kläning")]["count100Plus"], 29)
        self.assertIn("kl04", leagues)

    def test_doubles_count_but_do_not_distort_individual_average(self):
        season = {
            "teams": [{"code": "A", "roster": [
                {"id": 1, "name": "Spieler Eins"}, {"id": 2, "name": "Spieler Zwei"},
            ]}],
            "matches": [{"id": 10, "eventId": 20, "kind": "final"}],
        }
        report = [{
            "statusCd": "FINISH", "legsHome": 3, "legsAway": 1,
            "participantHome": {"displayName": "Spieler Eins & Spieler Zwei", "darts": 80, "score": 1900},
            "participantGuest": {"displayName": "Gegner A & Gegner B", "darts": 80, "score": 1700},
        }]
        with patch.object(darts_feed, "get_darts_season", return_value=season), \
             patch.object(darts_feed, "_load_player_match_stats", return_value=(report, [])), \
             patch.object(darts_feed, "_official_league_player_stats", return_value=({}, [])):
            result = darts_feed._load_player_stats(datetime(2026, 9, 27, tzinfo=timezone.utc))
        for player in result["players"].values():
            self.assertEqual(player["gamesPlayed"], 1)
            self.assertEqual(player["gamesWon"], 1)
            self.assertIsNone(player["average"])
            self.assertEqual(player["singlesPlayed"], 0)


if __name__ == "__main__":
    unittest.main()
