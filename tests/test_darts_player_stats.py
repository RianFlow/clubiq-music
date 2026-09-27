import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import darts_feed


class DartsPlayerStatsTests(unittest.TestCase):
    def setUp(self):
        darts_feed._player_stats_cache = None
        darts_feed._player_match_stats_cache.clear()

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
             patch.object(darts_feed, "_load_player_match_stats", return_value=(report, performances)):
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
             patch.object(darts_feed, "_load_player_match_stats", return_value=(report, [])):
            result = darts_feed._load_player_stats(datetime(2026, 9, 27, tzinfo=timezone.utc))
        for player in result["players"].values():
            self.assertEqual(player["gamesPlayed"], 1)
            self.assertEqual(player["gamesWon"], 1)
            self.assertIsNone(player["average"])
            self.assertEqual(player["singlesPlayed"], 0)


if __name__ == "__main__":
    unittest.main()
