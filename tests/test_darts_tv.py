import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import darts_tv as tv

NOW = datetime(2026, 10, 5, 8, tzinfo=timezone.utc)

def item(title, date, url="https://www.sport1.de/tv-video/stream/test__1"):
    return f'<a class="sport1-newsticker-video-group__link" href="{url}"><article><h3>{title}</h3><time datetime="{date}">ignored</time></article></a>'

class TvServiceTests(unittest.TestCase):
    def setUp(self):
        tv._cache = None
        tv._retry_at = 0

    def test_official_markup_deduplication_and_only_explicit_live_darts(self):
        good = item("Darts LIVE: Swiss &amp; Trophy", "2026-10-10T13:00:00+02:00")
        html = good + good + item("Motorsport LIVE: Rennen", "2026-10-10T10:00:00+02:00") + item("Darts Wiederholung", "2026-10-10T10:00:00+02:00")
        events = tv._parse(html)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["title"], "Swiss & Trophy")
        self.assertEqual(events[0]["kind"], "Livestream")

    def test_unknown_format_invalid_time_and_foreign_link_are_not_published(self):
        with self.assertRaises(ValueError): tv._parse("<p>Blocked</p>")
        html = item("Darts LIVE: Test", "2026-10-10T13:00:00") + item("Darts LIVE: Test", "bad") + item("Darts LIVE: Test", "2026-10-10T13:00:00+02:00", "https://example.com/")
        self.assertEqual(tv._parse(html), [])

    def test_past_starts_expire_even_inside_cache_and_far_dates_excluded(self):
        items = tv._parse(item("Darts LIVE: Past", NOW.isoformat()) + item("Darts LIVE: Next", (NOW + timedelta(minutes=10)).isoformat()) + item("Darts LIVE: Far", (NOW + timedelta(days=90)).isoformat()))
        with patch.object(tv, "_load", return_value=items) as load:
            self.assertEqual(len(tv.get_darts_tv(NOW)["events"]), 1)
            self.assertEqual(tv.get_darts_tv(NOW + timedelta(minutes=11))["events"], [])
            load.assert_called_once()

    def test_outage_uses_recent_snapshot_and_retries_are_bounded(self):
        with patch.object(tv, "_load", return_value=tv._parse(item("Darts LIVE: Next", "2026-10-10T13:00:00+02:00"))): tv.get_darts_tv(NOW)
        with patch.object(tv, "_load", side_effect=ValueError) as load:
            data = tv.get_darts_tv(NOW + timedelta(minutes=31))
            self.assertTrue(data["stale"])
            self.assertTrue(data["available"])
            self.assertEqual(len(data["events"]), 1)
            tv.get_darts_tv(NOW + timedelta(minutes=32))
            load.assert_called_once()
            self.assertFalse(tv.get_darts_tv(NOW + timedelta(days=2))["available"])

    def test_no_snapshot_is_an_honest_empty_state(self):
        with patch.object(tv, "_load", side_effect=ValueError):
            data = tv.get_darts_tv(NOW)
        self.assertFalse(data["available"])
        self.assertEqual(data["events"], [])
        self.assertIsNone(data["updatedAt"])
