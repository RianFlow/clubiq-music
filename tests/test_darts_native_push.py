import unittest
from unittest.mock import patch
import json

import main


class FakeDb:
    def __init__(self, fetchones=(), fetchalls=(), statements=None):
        self._fetchones = iter(fetchones)
        self._fetchalls = iter(fetchalls)
        self.statements = statements if statements is not None else []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self

    def execute(self, sql, params=None):
        self.statements.append((sql, params))

    def fetchone(self):
        return next(self._fetchones, None)

    def fetchall(self):
        return next(self._fetchalls, [])

    def commit(self):
        pass


class DartsNativePushTests(unittest.TestCase):
    def test_native_request_requires_android_bounded_token_and_random_secret_shape(self):
        good = {"platform": "android", "token": "t" * 120, "deviceSecret": "a" * 64}
        self.assertEqual(main.DartsNativePushRequest(**good).platform, "android")
        for changed in (
            {**good, "platform": "ios"},
            {**good, "token": "short"},
            {**good, "token": "x" * 100 + "!"},
            {**good, "deviceSecret": "not-a-secret"},
        ):
            with self.subTest(changed=changed), self.assertRaises(Exception):
                main.DartsNativePushRequest(**changed)

    def test_all_six_event_types_and_live_start_delivery_pipeline(self):
        request = main.DartsNativePushRequest(platform="android", token="t" * 120, deviceSecret="a" * 64, eventTypes=sorted(main.PUSH_EVENT_TYPES))
        self.assertIn("player_start", request.eventTypes)
        raw = {"type": "player_start", "matchId": 17, "gameId": "game-1", "playerSide": "home", "team": "SV Barver Darts A", "player": "Jannik", "board": "1"}
        with patch.object(main.darts_live_hub, "drain_events", return_value=[raw]), patch.object(main, "_store_and_deliver_darts_events") as store:
            main.deliver_darts_live_events()
        event = store.call_args[0][0][0]
        self.assertEqual(event["event_type"], "player_start")
        self.assertTrue(event["deliver"])

    def test_subscription_hashes_never_return_raw_secret(self):
        request = main.DartsNativePushRequest(
            platform="android", token="t" * 120, deviceSecret="A" * 64
        )
        token_digest, secret_digest = main._native_push_hashes(request)
        self.assertEqual(token_digest, main.token_hash("t" * 120))
        self.assertEqual(secret_digest, main.token_hash("a" * 64))
        self.assertNotIn("A" * 64, secret_digest)

    def test_missing_explicit_fcm_config_disables_native_push(self):
        with patch.object(main, "DARTS_FCM_CREDENTIALS", ""), patch.object(main, "firebase_admin", object()):
            self.assertFalse(main.native_fcm_configured())

    def test_new_live_event_queues_matching_native_delivery(self):
        statements = []
        db = FakeDb(fetchones=[(True,), (True,)],
                    fetchalls=[[], [("d" * 64, ["A"], [], ["180"])]], statements=statements)
        event = {"event_id": "e" * 64, "event_type": "180", "team": "A", "player": "Dart Player",
                 "match_id": 17, "title": "180", "body": "Dart Player", "url": "https://example.test/",
                 "tag": "event-17", "deliver": True}
        with patch.object(main, "db_connect", return_value=db), patch.object(main, "webpush", None):
            main._store_and_deliver_darts_events([event])
        queued = [(sql, params) for sql, params in statements if "INSERT INTO darts_native_push_outbox" in sql]
        self.assertEqual(len(queued), 1)
        payload = json.loads(queued[0][1][2])
        self.assertEqual(payload["matchId"], "17")
        self.assertEqual(payload["eventType"], "180")
        self.assertIn("5 minutes", queued[0][0])

    def test_subscribe_rejects_token_already_owned_by_another_secret(self):
        db = FakeDb(fetchones=[None, (1,)])
        request = main.DartsNativePushRequest(platform="android", token="t" * 120, deviceSecret="a" * 64)
        with patch.object(main, "_native_push_rate_limit"), patch.object(main, "native_fcm_configured", return_value=True), patch.object(main, "db_connect", return_value=db):
            with self.assertRaises(main.HTTPException) as raised:
                main.darts_native_push_subscribe(request, None, "1")
        self.assertEqual(raised.exception.status_code, 403)

    def test_transient_fcm_failure_schedules_retry_without_logging_token(self):
        digest = "d" * 64
        statement_log = []
        claim_db = FakeDb(fetchalls=[[(1, digest, "t" * 120, {"eventId": "e", "matchId": "17", "eventType": "180", "team": "A", "player": "P", "title": "180", "body": "P", "url": "https://example.test", "tag": "tag"}, 0)]], statements=statement_log)
        filter_db = FakeDb(fetchones=[(["A"], [], ["180"])], statements=statement_log)
        retry_db = FakeDb(statements=statement_log)
        with patch.object(main, "native_fcm_configured", return_value=True), \
             patch.object(main, "db_connect", side_effect=[claim_db, filter_db, retry_db]), \
             patch.object(main, "_native_fcm_send", side_effect=RuntimeError("mock transport failure")):
            main.deliver_native_darts_push_outbox()
        retry_updates = [(sql, params) for sql, params in statement_log if "SET next_attempt_at=CURRENT_TIMESTAMP" in sql]
        self.assertEqual(len(retry_updates), 1)
        self.assertEqual(retry_updates[0][1][1], 1)

    def test_fcm_message_includes_native_route_metadata_and_android_channel(self):
        class FakeMessaging:
            @staticmethod
            def Notification(**kwargs): return kwargs
            @staticmethod
            def AndroidNotification(**kwargs): return kwargs
            @staticmethod
            def AndroidConfig(**kwargs): return kwargs
            @staticmethod
            def Message(**kwargs): return kwargs
            @staticmethod
            def send(message, app=None): sent.append((message, app))

        class FakeCredentials:
            @staticmethod
            def Certificate(_path): return object()

        class FakeAdmin:
            @staticmethod
            def initialize_app(*_args, **_kwargs): return "mock-app"

        sent = []
        with patch.object(main, "firebase_messaging", FakeMessaging), \
             patch.object(main, "firebase_credentials", FakeCredentials), \
             patch.object(main, "firebase_admin", FakeAdmin), \
             patch.object(main, "native_fcm_configured", return_value=True), \
             patch.object(main, "_firebase_admin_app", None):
            main._native_fcm_send("t" * 120, {"title": "180", "body": "Player", "tag": "unique-tag",
                                              "eventId": "e" * 64, "matchId": "17", "eventType": "180",
                                              "team": "A", "player": "Player"})
        message, app = sent[0]
        self.assertEqual(app, "mock-app")
        self.assertEqual(message["data"]["matchId"], "17")
        self.assertEqual(message["data"]["eventType"], "180")
        self.assertEqual(message["android"]["ttl"], 300)
        self.assertEqual(message["android"]["priority"], "high")
        self.assertEqual(message["android"]["notification"]["channel_id"], "barver-sport")
        self.assertEqual(message["android"]["notification"]["tag"], "unique-tag")

    def test_owned_test_message_bypasses_sports_filters_but_requires_enabled_device(self):
        digest = "d" * 64
        payload = {"title": "ClubIQ Darts", "body": "Test", "url": "https://example.test", "tag": "clubiq-test",
                   "eventId": "e" * 64, "eventType": "test", "matchId": "", "team": "", "player": "", "isTest": True}
        claim_db = FakeDb(fetchalls=[[(1, digest, "t" * 120, payload, 0)]])
        filters_db = FakeDb(fetchones=[([], [], [])])
        sent_db = FakeDb()
        with patch.object(main, "native_fcm_configured", return_value=True), \
             patch.object(main, "db_connect", side_effect=[claim_db, filters_db, sent_db]), \
             patch.object(main, "_native_fcm_send") as send:
            main.deliver_native_darts_push_outbox()
        send.assert_called_once_with("t" * 120, payload)


if __name__ == "__main__":
    unittest.main()
