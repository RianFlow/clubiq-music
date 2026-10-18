import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from darts_schedule_status import current_schedule


class ScheduleStatusTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 18, 8, tzinfo=timezone.utc)
        self.old = {"id": 1, "kind": "upcoming", "score": None, "home": "Gast", "away": "Barver", "plannedAt": (self.now - timedelta(hours=18)).isoformat()}
        self.future = {**self.old, "id": 2, "plannedAt": (self.now + timedelta(days=2)).isoformat()}

    def test_expired_cached_fixture_is_not_advertised_as_next_without_inventing_a_result(self):
        source = {"stale": True, "matches": [self.old, self.future], "teams": [{"matches": [self.old, self.future], "nextMatch": self.old}]}
        result = current_schedule(source, self.now)
        self.assertEqual(result["matches"][0]["kind"], "pending")
        self.assertIsNone(result["matches"][0]["score"])
        self.assertEqual(result["teams"][0]["nextMatch"]["id"], 2)
        self.assertTrue(result["stale"])
        self.assertEqual(source["matches"][0]["kind"], "upcoming", "stored source must remain intact")

    def test_same_day_and_authoritative_results_remain(self):
        final = {**self.old, "kind": "final", "score": "4:8"}
        current = {**self.old, "plannedAt": (self.now - timedelta(hours=2)).isoformat()}
        rows = current_schedule({"items": [final, current, self.future]}, self.now, "items")["items"]
        self.assertEqual([row["kind"] for row in rows], ["final", "upcoming", "upcoming"])
        self.assertEqual(rows[0]["score"], "4:8")

    def test_aging_applies_to_collected_and_last_known_feed_paths(self):
        import darts_feed
        for collected in (True, False):
            payload = {"matches": [self.old], "items": [self.old]}
            with patch.object(darts_feed, "collected_snapshot", return_value=payload if collected else None), \
                 patch.object(darts_feed, "_season_cache", (self.now.timestamp(), payload)), \
                 patch.object(darts_feed, "_cache", payload), \
                 patch.object(darts_feed, "_cache_time", self.now.timestamp()), \
                 patch("darts_fixtures.overlay_fixtures", side_effect=lambda value, *args, **kwargs: value):
                self.assertEqual(darts_feed.get_darts_season(self.now)["matches"][0]["kind"], "pending")
                self.assertEqual(darts_feed.get_darts_feed(self.now)["items"][0]["kind"], "pending")
