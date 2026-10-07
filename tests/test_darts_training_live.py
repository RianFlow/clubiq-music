import copy
import json
import unittest
from unittest.mock import patch, MagicMock

import main
from darts_push import training_push_event, subscription_matches, push_payload
from darts_training_live import TrainingLiveMonitor, training_events
from test_darts_native_push import FakeDb


def board(now=1000):
    return {"groupKey": "32751", "matchKey": "901", "id": "901", "board": "1",
            "active": True, "finished": False, "comingSoon": False,
            "lastUpdateNs": now * 1000000000, "lastUpdate": "1970-01-01T00:16:40+00:00",
            "home": {"name": "Jannik", "legs": 0, "darts": 3, "count180": 0, "highFinish": 0},
            "guest": {"name": "Florian", "legs": 0, "darts": 3, "count180": 0, "highFinish": 0}}


class TrainingLiveTests(unittest.TestCase):
    def test_fcm_carries_training_navigation_without_private_data(self):
        messaging = MagicMock()
        with patch.object(main, "native_fcm_configured", return_value=True), patch.object(main, "_firebase_admin_app", object()), patch.object(main, "firebase_messaging", messaging):
            main._native_fcm_send("fixture-token", {"scope": "training", "trainingId": 32751, "title": "Training"})
        data = messaging.Message.call_args.kwargs["data"]
        self.assertEqual(data["scope"], "training")
        self.assertEqual(data["trainingId"], "32751")
        self.assertNotIn("token", data)

    def test_web_training_test_requires_owned_keys_and_is_rate_limited(self):
        keys = {"p256dh": "p" * 32, "auth": "a" * 32}
        payload = main.DartsPushSubscribe(endpoint="https://fcm.googleapis.com/wp/fixture", keys=keys, training=True)
        db = FakeDb(fetchones=[(keys["p256dh"], keys["auth"]), (1,)])
        with patch.object(main, "db_connect", return_value=db), patch.object(main, "DARTS_VAPID_PUBLIC_KEY", "fixture"), patch.object(main, "DARTS_VAPID_PRIVATE_KEY", "fixture"), patch.object(main, "get_trainings", return_value={"selectedId": 32751}), patch.object(main, "webpush") as send:
            self.assertTrue(main.darts_web_push_test(payload, "1")["ok"])
            delivered = json.loads(send.call_args.kwargs["data"])
            self.assertEqual(delivered["trainingId"], 32751)
            self.assertEqual(delivered["scope"], "training")
        for result, code in (([None], 403), ([("wrong", "keys")], 403), ([(keys["p256dh"], keys["auth"]), None], 429)):
            with patch.object(main, "db_connect", return_value=FakeDb(fetchones=result)), patch.object(main, "DARTS_VAPID_PUBLIC_KEY", "fixture"), patch.object(main, "DARTS_VAPID_PRIVATE_KEY", "fixture"), patch.object(main, "webpush") as send:
                with self.assertRaises(main.HTTPException) as caught:
                    main.darts_web_push_test(payload, "1")
                self.assertEqual(caught.exception.status_code, code)
                send.assert_not_called()

    def test_first_snapshot_never_announces_history(self):
        clock = [1000]
        monitor = TrainingLiveMonitor(clock=lambda: clock[0])
        first = board(); first["home"]["count180"] = 4
        monitor.apply(32751, [first])
        self.assertEqual(monitor.drain_events(), [])
        second = copy.deepcopy(first); clock[0] += 10
        second["lastUpdateNs"] += 10 * 1000000000; second["home"]["count180"] = 5
        monitor.apply(32751, [second])
        events = monitor.drain_events()
        self.assertEqual([e["type"] for e in events], ["180"])
        monitor.apply(32751, [second])
        self.assertEqual(monitor.drain_events(), [])

    def test_reconnect_and_old_or_backwards_updates_do_not_replay(self):
        clock = [1000]; monitor = TrainingLiveMonitor(clock=lambda: clock[0])
        first = board(); monitor.apply(32751, [first])
        later = copy.deepcopy(first); later["home"]["count180"] = 3
        clock[0] += 121; later["lastUpdateNs"] = clock[0] * 1000000000
        monitor.apply(32751, [later]); self.assertEqual(monitor.drain_events(), [])
        late = copy.deepcopy(later); late["home"]["count180"] = 4
        clock[0] += 200; late["lastUpdateNs"] += 1
        monitor.apply(32751, [late]); self.assertEqual(monitor.drain_events(), [])
        monitor.apply(32751, [first]); self.assertEqual(monitor.snapshot(32751)["matches"][0]["home"]["count180"], 4)

    def test_start_finish_leg_and_high_finish_are_independent_of_team_scores(self):
        first = board(); first["active"] = False
        playing = board()
        starts = training_events(first, playing, 32751)
        self.assertEqual([e["type"] for e in starts], ["player_start"])
        self.assertEqual(starts[0]["player"], "Jannik & Florian")
        end = copy.deepcopy(playing); end["finished"] = True; end["active"] = False
        end["home"].update(legs=3, highFinish=120)
        events = training_events(playing, end, 32751)
        self.assertEqual({e["type"] for e in events}, {"leg", "high_finish", "game"})
        final = training_push_event(next(e for e in events if e["type"] == "game"))
        self.assertIn("3:0", final["body"])
        self.assertEqual(json.loads(push_payload(final))["trainingId"], 32751)
        self.assertIn("/app/?training=32751", final["url"])

    def test_training_is_explicit_opt_in_and_player_filters_match_either_side(self):
        event = {"scope": "training", "event_type": "game", "team": "T", "player": "Jannik & Florian"}
        self.assertFalse(subscription_matches(event, ["A", "B"], ["Jannik"], ["game"]))
        self.assertTrue(subscription_matches(event, [], [], ["game"], True))
        self.assertTrue(subscription_matches(event, [], ["florian"], ["game"], True))
        self.assertFalse(subscription_matches(event, ["A"], ["Patrick"], ["game"], True))
        self.assertFalse(subscription_matches(event, [], [], ["180"], True))
        self.assertFalse(subscription_matches({"team": "A", "event_type": "game"}, [], [], ["game"], True))

    def test_training_defaults_off_and_queue_keeps_scope_for_delivery_and_navigation(self):
        self.assertFalse(main.DartsNativePushRequest(platform="android", token="t"*120, deviceSecret="a"*64).training)
        statements = []
        db = FakeDb(fetchones=[(True,), (True,)], fetchalls=[[], [("d"*64, [], [], ["180"], True)]], statements=statements)
        raw = {"scope": "training", "trainingId": 32751, "type": "180", "matchId": 32751,
               "performanceId": "901:home:180:1", "player": "Jannik", "value": 180, "count": 1}
        event = training_push_event(raw)
        with patch.object(main, "db_connect", return_value=db), patch.object(main, "webpush", None):
            main._store_and_deliver_darts_events([{**event, "deliver": True}])
        inserts = [params for sql, params in statements if "INSERT INTO darts_native_push_outbox" in sql]
        self.assertEqual(len(inserts), 1)
        payload = json.loads(inserts[0][2]); self.assertEqual(payload["scope"], "training"); self.assertEqual(payload["trainingId"], 32751)

    def test_wrong_event_does_not_enter_live_view_and_outage_is_stale(self):
        monitor = TrainingLiveMonitor(clock=lambda: 1000)
        wrong = board(); wrong["groupKey"] = "32260"
        monitor.apply(32751, [wrong]); self.assertEqual(monitor.snapshot(32751)["matches"], [])
        monitor.apply(32751, [board()]); monitor.apply(32751, [])
        self.assertTrue(monitor.snapshot(32751)["stale"])
        self.assertEqual(len(monitor.snapshot(32751)["matches"]), 1)
        self.assertEqual(monitor.drain_events(), [])
