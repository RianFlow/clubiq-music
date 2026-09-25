import unittest
from datetime import datetime, timezone

from darts_feed import _game_events, _leg_events, _performance_events, _preferred_round, _relevant_rounds, _standings, _ticker_item


class DartsFeedTests(unittest.TestCase):
    def test_selects_previous_and_next_round(self):
        rounds = [
            {"id": 1, "dateFrom": "2026-09-04T00:00:00+02:00"},
            {"id": 2, "dateFrom": "2026-09-25T00:00:00+02:00"},
            {"id": 3, "dateFrom": "2026-10-09T00:00:00+02:00"},
        ]
        selected = _relevant_rounds(rounds, datetime(2026, 9, 21, tzinfo=timezone.utc))
        self.assertEqual([item["id"] for item in selected], [1, 2])

    def test_prefers_active_round_over_next_round(self):
        rounds = [
            {"id": 3, "dateFrom": "2026-09-24T22:00:00+00:00", "dateTo": "2026-09-26T22:00:00+00:00"},
            {"id": 4, "dateFrom": "2026-10-08T22:00:00+00:00", "dateTo": "2026-10-10T22:00:00+00:00"},
        ]
        selected = _preferred_round(rounds, datetime(2026, 9, 25, 18, 0, tzinfo=timezone.utc))
        self.assertEqual(selected["id"], 3)

    def test_prefers_next_round_outside_active_window(self):
        rounds = [
            {"id": 3, "dateFrom": "2026-09-24T22:00:00+00:00", "dateTo": "2026-09-26T22:00:00+00:00"},
            {"id": 4, "dateFrom": "2026-10-08T22:00:00+00:00", "dateTo": "2026-10-10T22:00:00+00:00"},
        ]
        selected = _preferred_round(rounds, datetime(2026, 9, 30, 18, 0, tzinfo=timezone.utc))
        self.assertEqual(selected["id"], 4)

    def test_finished_match_names_winner_and_whitelists_fields(self):
        match = {
            "id": 1280523,
            "eventId": 1445,
            "statusCd": "FINISH",
            "setsHome": 8,
            "setsAway": 4,
            "participantHome": {"id": 174110, "displayName": "SV Barver Darts A", "email": "private@example.test"},
            "participantGuest": {"id": 174115, "displayName": "TuS Lemförde A"},
            "datePlanned": "2026-09-17T18:30:00+02:00",
            "endDate": "2026-09-17T21:26:28+02:00",
        }
        item = _ticker_item(match, 2139, 34271)
        self.assertEqual(item["kind"], "final")
        self.assertEqual(item["text"], "SV Barver Darts A gewinnt 8:4 gegen TuS Lemförde A")
        self.assertNotIn("email", item)
        self.assertTrue(item["url"].endswith("?matchId=1280523"))

    def test_finished_away_win_displays_winner_score_first(self):
        match = {
            "id": 1296302,
            "eventId": 1460,
            "statusCd": "FINISH",
            "setsHome": 4,
            "setsAway": 8,
            "participantHome": {"id": 174266, "displayName": "SV Barver Darts D"},
            "participantGuest": {"id": 174262, "displayName": "TSV Drebber C"},
        }
        item = _ticker_item(match, 2154, 34524)
        self.assertEqual(item["text"], "TSV Drebber C gewinnt 8:4 gegen SV Barver Darts D")

    def test_standings_only_exposes_public_team_fields(self):
        matches = [{
            "participantHome": {"id": 174110, "displayName": "SV Barver Darts A", "rankingPos": 3, "email": "private@example.test"},
            "participantGuest": {"id": 1, "displayName": "Lohne", "rankingPos": 1, "phone": "secret"},
        }]
        standings = _standings(matches, {174110})
        self.assertEqual([entry["rank"] for entry in standings], [1, 3])
        self.assertTrue(standings[1]["barver"])
        self.assertNotIn("email", str(standings))
        self.assertNotIn("phone", str(standings))

    def test_real_180_and_game_winner_events_are_normalized(self):
        match = {"id": 99}
        performances = [{"performanceTypeCd": "HS", "value": 180, "count": 2, "participant": {"displayName": "Jannik"}, "team": {"name": "SV Barver Darts A"}, "private": "removed"}]
        self.assertEqual(_performance_events(performances, match)[0]["title"], "180!")
        games = [{"gameNrRound": 2, "statusCd": "FINISH", "legsHome": 3, "legsAway": 1, "participantHome": {"displayName": "Jannik"}, "participantGuest": {"displayName": "Max"}}]
        self.assertEqual(_game_events(games, match)[0]["text"], "Jannik gewinnt 3:1 gegen Max")

    def test_high_finish_and_live_leg_are_normalized(self):
        match = {"id": 99}
        performances = [{"id": 4, "performanceTypeCd": "HF", "value": 111, "count": 1, "participant": {"displayName": "Jannik"}, "team": {"name": "SV Barver Darts A"}}]
        high_finish = _performance_events(performances, match)[0]
        self.assertEqual((high_finish["type"], high_finish["value"]), ("high_finish", 111))
        games = [{
            "id": 7, "gameNr": 2, "statusCd": "ACTIVE", "liveLegsHome": 2, "liveLegsAway": 1,
            "participantHome": {"displayName": "Jannik"}, "participantGuest": {"displayName": "Max"},
        }]
        legs = _leg_events(games, match, "SV Barver Darts A")
        self.assertEqual([(event["winnerSide"], event["legCount"]) for event in legs], [("home", 2), ("away", 1)])
        self.assertEqual(legs[0]["text"], "Jannik 2:1 Max")


if __name__ == "__main__":
    unittest.main()
