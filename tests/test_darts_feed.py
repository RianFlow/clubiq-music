import unittest
from datetime import datetime, timezone

from darts_feed import _relevant_rounds, _ticker_item


class DartsFeedTests(unittest.TestCase):
    def test_selects_previous_and_next_round(self):
        rounds = [
            {"id": 1, "dateFrom": "2026-09-04T00:00:00+02:00"},
            {"id": 2, "dateFrom": "2026-09-25T00:00:00+02:00"},
            {"id": 3, "dateFrom": "2026-10-09T00:00:00+02:00"},
        ]
        selected = _relevant_rounds(rounds, datetime(2026, 9, 21, tzinfo=timezone.utc))
        self.assertEqual([item["id"] for item in selected], [1, 2])

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


if __name__ == "__main__":
    unittest.main()
