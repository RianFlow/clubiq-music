import json
import unittest

from datetime import datetime, timezone

from darts_push import barver_180_candidates, barver_180_event, barver_push_candidates, barver_push_event, push_payload, valid_push_endpoint, valid_push_key, subscription_matches


class DartsPushTests(unittest.TestCase):
    def test_player_start_is_opt_in_and_has_stable_identity(self):
        raw = {"type": "player_start", "matchId": 12, "gameId": "board-game-1", "playerSide": "home", "board": "2", "team": "SV Barver Darts A", "player": "Jannik & Max"}
        event = barver_push_event("live", raw)
        self.assertIn("startet", event["title"])
        self.assertIn("Board 2", event["body"])
        self.assertFalse(subscription_matches(event, ["A"], [], ["game", "match"]))
        self.assertTrue(subscription_matches(event, [], ["Max"], ["player_start"]))
        self.assertEqual(event["event_id"], barver_push_event("live", {**raw, "board": "3"})["event_id"])
        self.assertNotEqual(event["event_id"], barver_push_event("live", {**raw, "gameId": "board-game-2"})["event_id"])
        self.assertIsNone(barver_push_event("live", {**raw, "gameId": ""}))

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

    def test_normalizes_high_finish_leg_game_and_match_result(self):
        samples = [
            ({"type": "high_finish", "matchId": 12, "performanceId": 5, "value": 111, "player": "Jannik", "team": "SV Barver Darts A"}, "🔥 High Finish 111"),
            ({"type": "leg", "matchId": 12, "gameId": 7, "winnerSide": "home", "legCount": 2, "title": "Leg für Jannik", "text": "Jannik 2:1 Max", "player": "Jannik", "team": "SV Barver Darts A"}, "🎯 Leg für Jannik"),
            ({"type": "game", "matchId": 12, "gameId": 7, "homeLegs": 3, "awayLegs": 1, "barverWon": True, "text": "Jannik gewinnt 3:1 gegen Max", "player": "Jannik", "team": "SV Barver Darts A"}, "✅ Partie gewonnen"),
            ({"type": "match", "matchId": 12, "score": "8:4", "text": "SV Barver Darts A gewinnt 8:4 gegen Gäste", "team": "SV Barver Darts A"}, "🏁 Endstand Barver A"),
        ]
        self.assertEqual([barver_push_event("kl04", item)["title"] for item, _ in samples], [title for _, title in samples])

    def test_live_events_and_fresh_final_are_deliverable(self):
        now = datetime(2026, 9, 25, 18, 0, tzinfo=timezone.utc)
        center = {
            "barverMatches": [
                {"id": 12, "kind": "live"},
                {"id": 13, "kind": "final", "updatedAt": "2026-09-25T17:58:00+00:00"},
            ],
            "pushEvents": [
                {"type": "leg", "matchId": 12, "gameId": 7, "winnerSide": "home", "legCount": 1, "title": "Leg für Jannik", "text": "Jannik 1:0 Max", "player": "Jannik", "team": "SV Barver Darts A"},
                {"type": "game", "matchId": 13, "gameId": 8, "homeLegs": 3, "awayLegs": 2, "barverWon": True, "text": "Jannik gewinnt", "player": "Jannik", "team": "SV Barver Darts B"},
                {"type": "match", "matchId": 13, "score": "8:4", "text": "Barver gewinnt", "team": "SV Barver Darts B"},
            ],
        }
        self.assertEqual([event["deliver"] for event in barver_push_candidates("kl04", center, now)], [True, True, True])

    def test_report_losses_follow_barver_player_and_keep_average_in_payload(self):
        from darts_feed import _game_events, _leg_events
        match = {"id": 12, "participantHome": {"displayName": "Gäste"}, "participantGuest": {"displayName": "SV Barver Darts B"}}
        raw = {"id": 7, "statusCd": "FINISH", "legsHome": 3, "legsAway": 1,
               "participantHome": {"displayName": "Gegner", "score": 1503, "darts": 75},
               "participantGuest": {"displayName": "Max", "score": 1002, "darts": 60}}
        event = _game_events([raw], match, "SV Barver Darts B", "away")[0]
        self.assertEqual(event["player"], "Max")
        self.assertFalse(event["barverWon"])
        self.assertIn("Max verliert 1:3", event["text"])
        self.assertIn("AVG 50,1 / 60,1", event["text"])
        normalized = barver_push_event("kl04", event)
        self.assertTrue(subscription_matches(normalized, [], ["Max"], ["game"]))
        self.assertIn("AVG 50,1", json.loads(push_payload(normalized))["body"])
        live = _leg_events([{**raw, "statusCd": "ACTIVE", "liveLegsHome": 1, "liveLegsAway": 0}], match, "SV Barver Darts B", "away")[0]
        self.assertEqual(live["player"], "Max")
        self.assertFalse(live["barverWon"])
        self.assertIn("Leg verloren", live["title"])

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
