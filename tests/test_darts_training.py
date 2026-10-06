from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import patch
import requests
import darts_training as training
import darts_tournament as tournament


def event(identifier=32260, status="FINISH", date="2026-09-21T22:00:00Z"):
    return {"id": identifier, "name": "Training 22.09.2026", "statusCd": status,
            "datetime": date, "dbId": 5, "mandantKey": 1931, "paid": True}


class TrainingTests(TestCase):
    def setUp(self):
        self.old = training._catalog, training._catalog_attempt, training._event_cache
        training._catalog, training._catalog_attempt, training._event_cache = None, 0, {}
        self.good = {"event": {"id": 32260}, "participants": [{"name": "A"}], "groups": [],
                     "matches": [], "performances": [{"name": "A", "value": 180}], "placements": [],
                     "updatedAt": "2026-10-06T09:00:00Z", "stale": False,
                     "source": "https://portal.3k-darts.com/frontend/events/5/event/32260/participants"}

    def tearDown(self):
        training._catalog, training._catalog_attempt, training._event_cache = self.old

    def test_models_only_include_barver_trainings_and_public_metadata(self):
        self.assertEqual(training.training_model(event())["id"], 32260)
        self.assertNotIn("paid", training.training_model(event()))
        self.assertIsNone(training.training_model({**event(), "datetime": {"private": "metadata"}})["date"])
        for changes in ({"mandantKey": 9}, {"name": "DBD Runde"}, {"dbId": 10}, {"id": True}, {"id": 0}):
            self.assertIsNone(training.training_model({**event(), **changes}))

    def test_selection_next_running_latest_and_berlin_midnight(self):
        past = training.training_model(event())
        today = training.training_model(event(33000, "CREATED", "2026-10-05T22:00:00Z"))
        later = training.training_model(event(33001, "CREATED", "2026-10-07T22:00:00Z"))
        now = datetime(2026, 10, 6, 10, tzinfo=timezone.utc)
        self.assertEqual(training.select_training([past, later, today], now)["selectedId"], 33000)
        active = {**past, "status": "ACTIVE"}
        self.assertEqual(training.select_training([active, later], now)["selectedId"], 32260)
        self.assertEqual(training.select_training([past, {**later, "status": "CANCELLED"}], now)["nextId"], None)
        self.assertEqual(training.select_training([past], now), {"selectedId": 32260, "nextId": None})
        self.assertEqual(training.select_training([{**past, "date": "bad"}], now)["selectedId"], None)

    def test_discovery_paginates_and_preserves_known_hidden_training(self):
        known = {"events": [training.training_model(event())], "updatedAt": self.good["updatedAt"]}
        def read(url):
            if "/page?" in url:
                return {"totalPages": 2, "content": [event(31849 if "page=0&" in url else 20147)]}
            return {"event": event(int(url.rsplit("/", 1)[1]))}
        with patch.object(training, "_public_get", side_effect=read) as source:
            result = training._discover(known)
        self.assertEqual({e["id"] for e in result["events"]}, {32260, 31849, 20147})
        self.assertFalse(result["stale"])
        self.assertEqual(source.call_count, 5)

    def test_failed_detail_does_not_claim_catalog_is_fresh(self):
        known = {"events": [training.training_model(event())], "updatedAt": self.good["updatedAt"]}
        with patch.object(training, "_public_get", side_effect=[{"content": [], "totalPages": 0}, requests.Timeout()]):
            result = training._discover(known)
        self.assertTrue(result["stale"])
        self.assertEqual(result["updatedAt"], known["updatedAt"])

    def test_catalog_outage_uses_seed_and_throttles_manual_retries(self):
        with patch.object(training, "load_snapshot", return_value=None), \
             patch.object(training, "_discover", side_effect=requests.Timeout) as discover, \
             patch.object(training.time, "monotonic", return_value=100):
            first = training.get_trainings(force=True)
            second = training.get_trainings(force=True)
        self.assertTrue(first["stale"])
        self.assertEqual(first["events"], second["events"])
        self.assertEqual(discover.call_count, 1)

    def test_new_confirmed_training_reaches_older_saved_catalog_during_outage(self):
        old = {"events": [training.training_model(event())], "updatedAt": self.good["updatedAt"]}
        today = training.training_model(event(32751, "ACTIVE", "2026-10-05T22:00:00Z"))
        with patch.object(training, "SEED", {**old, "events": [today]}), \
             patch.object(training, "load_snapshot", return_value=old), \
             patch.object(training, "_discover", side_effect=requests.Timeout):
            result = training.get_trainings()
        self.assertTrue(result["stale"])
        self.assertEqual(result["selectedId"], 32751)
        self.assertEqual({e["id"] for e in result["events"]}, {32260, 32751})

    def test_durable_snapshot_is_used_after_a_previous_failed_request(self):
        training._event_cache[32260] = (100, None)
        with patch.object(training, "load_snapshot", return_value=self.good), \
             patch.object(training.time, "monotonic", return_value=101):
            self.assertEqual(training.get_training(32260)["event"]["id"], 32260)

    def test_restart_outage_keeps_matching_event_and_original_time(self):
        with patch.object(training, "load_snapshot", return_value=self.good) as load, \
             patch.object(training, "_detail", side_effect=requests.Timeout):
            result = training.get_training(32260)
        load.assert_called_once_with("training:32260")
        self.assertTrue(result["stale"])
        self.assertEqual(result["updatedAt"], self.good["updatedAt"])
        self.assertEqual(result["source"], self.good["source"])
        with patch.object(training, "load_snapshot", return_value=None), patch.object(training, "_detail", side_effect=requests.Timeout):
            with self.assertRaises(RuntimeError):
                training.get_training(31849)

    def test_foreign_training_rejected_without_using_previous_data(self):
        with patch.object(training, "load_snapshot", return_value=self.good), \
             patch.object(training, "_detail", return_value=({"event": event() | {"mandantKey": 9}}, None, None, None)):
            with self.assertRaises(training.InvalidTraining):
                training.get_training(32260)

    def test_partial_extras_keep_known_best_performances(self):
        partial = {**self.good, "performances": [], "performancesUnavailable": True, "degraded": True}
        with patch.object(training, "load_snapshot", return_value=self.good), \
             patch.object(training, "_detail", return_value=({"event": event()}, None, None, None)), \
             patch.object(training, "_load", return_value=partial), patch.object(training, "save_snapshot") as save:
            result = training.get_training(32260)
        save.assert_not_called()
        self.assertEqual(result["performances"], self.good["performances"])
        self.assertTrue(result["degraded"])

    def test_extras_normalize_only_public_results(self):
        raw = {"performanceCatalog": [{"performanceTypeCd": "HS", "playerPerformances": [
            {"value": 180, "count": 2, "participant": {"displayName": "A", "paid": True, "email": "private"}},
            {"value": 140, "participant": {"displayName": "B"}}]}]}
        self.assertEqual(tournament.performance_models(raw), [{"type": "HS", "name": "A", "value": 180, "count": 2}])
        self.assertEqual(tournament.placement_models([{"place": "2.", "participant": {"displayName": "A", "paidDate": "private"}}]), [{"rank": "2.", "name": "A"}])
        for parser in (tournament.performance_models, tournament.placement_models):
            with self.assertRaises(ValueError): parser({"bad": "payload"})
