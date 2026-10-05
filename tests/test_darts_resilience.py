import unittest
from datetime import datetime, timezone, timedelta
from threading import Event, Thread
from unittest.mock import Mock, patch

import requests
import darts_feed as feed
from darts_resilience import PublicSourceRecovery, SourceCoolingDown, save_snapshot


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 5, tzinfo=timezone.utc)
        self.good = {"updatedAt": self.now.isoformat(), "items": [{"id": 1}], "stale": False}
        self.old_cache = feed._cache, feed._cache_time, feed._season_cache
        feed._cache, feed._cache_time, feed._season_cache = None, 0, None

    def tearDown(self):
        feed._cache, feed._cache_time, feed._season_cache = self.old_cache

    def test_network_retry_is_bounded_and_recovers(self):
        clock = [0]
        recovery = PublicSourceRecovery(lambda: clock[0])
        request = Mock(side_effect=requests.ConnectTimeout)
        for delay in (30, 60, 120, 300, 300):
            with self.assertRaises(requests.ConnectTimeout):
                recovery.get(request, "https://backend-ddv.3k-darts.com/test")
            calls = request.call_count
            clock[0] += delay - 1
            with self.assertRaises(SourceCoolingDown):
                recovery.get(request, "https://backend-ddv.3k-darts.com/another")
            self.assertEqual(request.call_count, calls)
            clock[0] += 1
        request.side_effect = None
        request.return_value = Mock(status_code=200)
        recovery.get(request, "https://backend-ddv.3k-darts.com/test")
        recovery.get(request, "https://backend-ddv.3k-darts.com/test")
        self.assertEqual(recovery.states["backend-ddv.3k-darts.com"]["failures"], 0)

    def test_only_one_probe_runs_after_cooldown(self):
        clock = [0]
        recovery = PublicSourceRecovery(lambda: clock[0])
        with self.assertRaises(requests.Timeout):
            recovery.get(Mock(side_effect=requests.Timeout), "https://source.test/one")
        clock[0] = 30
        started, release = Event(), Event()
        def probe(url):
            started.set(); release.wait(2)
            return Mock(status_code=200)
        thread = Thread(target=lambda: recovery.get(probe, "https://source.test/one"))
        thread.start(); self.assertTrue(started.wait(1))
        try:
            with self.assertRaises(SourceCoolingDown):
                recovery.get(Mock(), "https://source.test/two")
        finally:
            release.set(); thread.join()

    def test_ticker_survives_process_restart_and_keeps_original_time(self):
        with patch.object(feed, "_load", side_effect=requests.ConnectTimeout), \
             patch.object(feed, "load_snapshot", return_value=self.good) as load:
            result = feed.get_darts_feed(self.now + timedelta(hours=2))
        self.assertTrue(result["stale"])
        self.assertEqual(result["updatedAt"], self.good["updatedAt"])
        self.assertEqual(result["items"], self.good["items"])
        load.assert_called_once_with("ticker")

    def test_successful_retry_replaces_snapshot(self):
        feed._cache = self.good
        fresh = {**self.good, "updatedAt": (self.now + timedelta(hours=2)).isoformat()}
        with patch.object(feed, "_load", return_value=fresh), patch.object(feed, "save_snapshot") as save:
            result = feed.get_darts_feed(self.now + timedelta(hours=2))
        self.assertFalse(result["stale"])
        save.assert_called_once_with("ticker", fresh)

    def test_total_season_outage_does_not_claim_empty_fresh_data(self):
        with patch.object(feed, "_load_league_season", side_effect=requests.Timeout):
            with self.assertRaises(feed.DartsFeedUnavailable):
                feed._load_season(self.now)

    def test_partial_season_never_overwrites_complete_snapshot(self):
        good = {"matches": [{"id": 1}], "teams": [{"code": "A"}], "updatedAt": self.now.isoformat()}
        feed._season_cache = (0, good)
        with patch.object(feed, "_load_season", return_value={"matches": [], "degraded": True}), \
             patch.object(feed, "save_snapshot") as save:
            result = feed.get_darts_season(self.now)
        self.assertTrue(result["stale"])
        self.assertEqual(result["matches"], good["matches"])
        self.assertEqual(result["updatedAt"], good["updatedAt"])
        self.assertEqual(feed._season_cache[1], good)
        save.assert_not_called()

    def test_season_recovers_from_durable_snapshot_after_restart(self):
        with patch.object(feed, "_load_season", side_effect=feed.DartsFeedUnavailable), \
             patch.object(feed, "load_snapshot", return_value=self.good):
            self.assertTrue(feed.get_darts_season(self.now)["stale"])

    def test_center_snapshot_is_scoped_to_requested_league_and_round(self):
        feed._center_cache.clear()
        with patch("darts_resilience.source_recovery.get", side_effect=requests.Timeout), \
             patch.object(feed, "load_snapshot", return_value=self.good) as load:
            result = feed.get_darts_center("kk11", 123, self.now)
        self.assertTrue(result["stale"])
        load.assert_called_once_with("center:kk11:123")

    def test_degraded_payload_is_not_written_to_database(self):
        with patch("darts_resilience.snapshot_connection") as conn:
            save_snapshot("season", {**self.good, "degraded": True})
            save_snapshot("ticker", {**self.good, "stale": True})
        conn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
