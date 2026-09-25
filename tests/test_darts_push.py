import json
import unittest

from darts_push import barver_180_candidates, barver_180_event, push_payload, valid_push_endpoint, valid_push_key


class DartsPushTests(unittest.TestCase):
    def test_normalizes_barver_180_and_keeps_player_name(self):
        event = barver_180_event("kl04", {
            "type": "180", "matchId": 123, "player": "Jannik Kläning",
            "team": "SV Barver Darts A", "count": 2,
        })
        self.assertEqual(event["team"], "A")
        self.assertEqual(event["title"], "🎯 180! Jannik Kläning")
        self.assertIn("2×", event["body"])
        self.assertEqual(json.loads(push_payload(event))["url"], "https://barverdarts.clubiq.party/")

    def test_ignores_opponents_and_non_180_events(self):
        self.assertIsNone(barver_180_event("kl04", {"type": "game", "matchId": 1}))
        self.assertIsNone(barver_180_event("kl04", {
            "type": "180", "matchId": 1, "player": "Gegner", "team": "Anderer Verein",
        }))

    def test_only_marks_180_from_a_currently_live_match_for_delivery(self):
        center = {
            "barverMatches": [
                {"id": 12, "kind": "live"},
                {"id": 11, "kind": "final"},
            ],
            "events": [
                {"type": "180", "matchId": 11, "player": "Alt", "team": "SV Barver Darts A"},
                {"type": "180", "matchId": 12, "player": "Live", "team": "SV Barver Darts A"},
            ],
        }
        candidates = barver_180_candidates("kl04", center)
        self.assertEqual([event["live"] for event in candidates], [False, True])

    def test_allows_known_browser_push_services_only(self):
        for endpoint in (
            "https://fcm.googleapis.com/wp/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/QWERTY",
            "https://wns2-bl2p.notify.windows.com/w/?token=abc",
        ):
            self.assertEqual(valid_push_endpoint(endpoint), endpoint)
        for endpoint in (
            "http://fcm.googleapis.com/x",
            "https://evil.test/x",
            "https://fcm.googleapis.com.evil.test/x",
            "https://fcm.googleapis.com:invalid/x",
        ):
            with self.assertRaises(ValueError):
                valid_push_endpoint(endpoint)

    def test_validates_subscription_keys(self):
        self.assertEqual(valid_push_key("AbCdEfGhIjKlMnOp"), "AbCdEfGhIjKlMnOp")
        for value in ("short", "<script>invalid-key", "a" * 300):
            with self.assertRaises(ValueError):
                valid_push_key(value)


if __name__ == "__main__":
    unittest.main()
