import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import requests
import darts_feed as feed


class MatchRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 6, tzinfo=timezone.utc)
        self.match = {"id": 123, "eventId": 1445, "kind": "upcoming", "home": "Gäste",
                      "away": "SV Barver Darts B", "plannedAt": "2026-10-09T18:00:00+00:00",
                      "homeVenue": {"street": "Teststraße 1"}, "url": "https://portal.3k-darts.com/"}
        self.season = {"matches": [self.match], "stale": True, "updatedAt": "2026-10-05T09:00:00+00:00"}
        self.cache = feed._match_cache.copy()
        feed._match_cache.clear()

    def tearDown(self):
        feed._match_cache.clear(); feed._match_cache.update(self.cache)

    def test_upcoming_game_opens_without_requiring_an_unpublished_report(self):
        with patch.object(feed, "get_darts_season", return_value=self.season), patch.object(feed, "_public_get") as get:
            data = feed.get_darts_match(123, self.now)
        get.assert_not_called()
        self.assertEqual(data["match"]["plannedAt"], self.match["plannedAt"])
        self.assertEqual(data["match"]["homeVenue"], self.match["homeVenue"])
        self.assertFalse(data["reportAvailable"])
        self.assertTrue(data["stale"])
        self.assertEqual(data["updatedAt"], self.season["updatedAt"])

    def test_failed_report_keeps_known_game_visible_without_fabricating_stats(self):
        self.match["kind"] = "final"; self.match["score"] = "4:8"
        with patch.object(feed, "get_darts_season", return_value=self.season), \
             patch.object(feed, "_public_get", side_effect=requests.Timeout), \
             patch.object(feed, "load_snapshot", return_value=None):
            data = feed.get_darts_match(123, self.now)
        self.assertTrue(data["reportUnavailable"])
        self.assertEqual(data["match"]["score"], "4:8")
        self.assertEqual(data["games"], [])
        self.assertEqual(data["performances"], [])

    def test_durable_report_is_used_after_restart_with_original_timestamp(self):
        self.match["kind"] = "final"
        previous = {"match": self.match, "reportAvailable": True, "games": [{"id": 8}], "updatedAt": self.season["updatedAt"]}
        with patch.object(feed, "get_darts_season", return_value=self.season), \
             patch.object(feed, "_public_get", side_effect=requests.Timeout), \
             patch.object(feed, "load_snapshot", return_value=previous) as load:
            data = feed.get_darts_match(123, self.now)
        load.assert_called_once_with("match:1445:123")
        self.assertTrue(data["stale"])
        self.assertEqual(data["games"], previous["games"])
        self.assertEqual(data["updatedAt"], previous["updatedAt"])

    def test_good_report_persists_only_normalized_public_fields(self):
        self.match["kind"] = "final"; self.season["stale"] = False
        raw = [{"id": 9, "gameNr": 1, "statusCd": "FINISH", "legsHome": 1, "legsAway": 3,
                "participantHome": {"displayName": "Heim", "email": "private@example.test"},
                "participantGuest": {"displayName": "Gast", "phone": "private"}}]
        with patch.object(feed, "get_darts_season", return_value=self.season), \
             patch.object(feed, "_public_get", side_effect=[raw, []]), patch.object(feed, "save_snapshot") as save:
            data = feed.get_darts_match(123, self.now)
        self.assertTrue(data["reportAvailable"])
        save.assert_called_once_with("match:1445:123", data)
        self.assertNotIn("private", str(data))

    def test_foreign_match_never_fetches_or_returns_a_cached_report(self):
        with patch.object(feed, "get_darts_season", return_value=self.season), patch.object(feed, "_public_get") as get:
            with self.assertRaises(ValueError): feed.get_darts_match(999, self.now)
        get.assert_not_called()
