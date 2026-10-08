from datetime import datetime, timezone, timedelta
import json
import os
import unittest
from unittest.mock import Mock, patch

import darts_collector as module
import darts_feed as feed
import darts_training as training
import darts_ranking as ranking
import darts_resilience as resilience


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026,10,8,18,tzinfo=timezone.utc)
        self.clock = 0
        self.good = {"updatedAt":self.now.isoformat(),"stale":False,"specialEventsAvailable":True,"items":[{"id":1}]}

    def collector(self, loader, writer=None):
        return module.Collector({"ticker":(60,loader)},persist=writer or Mock(),clock=lambda:self.clock,now=lambda:self.now)

    def test_runs_and_repeats_without_visitors(self):
        loader = Mock(return_value=[("ticker",self.good)])
        writer = Mock()
        collector = self.collector(loader,writer)
        self.assertTrue(collector.cycle()["allSourcesFresh"])
        self.assertEqual(writer.call_count,1)
        self.clock=59
        collector.cycle()
        self.assertEqual(loader.call_count,1)
        self.clock=60
        collector.cycle()
        self.assertEqual(loader.call_count,2)

    def test_failure_preserves_success_and_bounded_retry_recovers(self):
        loader = Mock(return_value=[("ticker",self.good)])
        writer = Mock()
        collector = self.collector(loader,writer)
        original=collector.cycle()["datasets"]["ticker"]["lastSuccess"]
        loader.side_effect=TimeoutError("private diagnostic text")
        self.clock=60
        status=collector.cycle()
        self.assertFalse(status["allSourcesFresh"])
        self.assertEqual(status["datasets"]["ticker"]["lastSuccess"],original)
        self.assertNotIn("private diagnostic text",json.dumps(status))
        for delay in (30,60,120,300):
            calls=loader.call_count
            self.clock+=delay-1
            collector.cycle()
            self.assertEqual(loader.call_count,calls)
            self.clock+=1
            collector.cycle()
        loader.side_effect=None
        self.clock+=300
        self.assertTrue(collector.cycle()["allSourcesFresh"])
        self.assertEqual(collector.states["ticker"]["failures"],0)

    def test_stale_incomplete_empty_and_future_data_never_written(self):
        bad=[{**self.good,"stale":True},{**self.good,"degraded":True},{**self.good,"updatedAt":(self.now+timedelta(minutes=3)).isoformat()},{**self.good,"updatedAt":(self.now-timedelta(minutes=10)).isoformat()}]
        for payload in bad:
            writer=Mock()
            status=self.collector(lambda:[("ticker",payload)],writer).cycle()
            self.assertFalse(status["allSourcesFresh"])
            writer.assert_not_called()
        self.assertFalse(self.collector(lambda:[]).cycle()["allSourcesFresh"])

    def test_persistence_failure_does_not_claim_success(self):
        writer=Mock(side_effect=RuntimeError("DB_PASSWORD=do-not-print"))
        status=self.collector(lambda:[("ticker",self.good)],writer).cycle()
        self.assertIsNone(status["datasets"]["ticker"]["lastSuccess"])
        self.assertNotIn("do-not-print",json.dumps(status))

    def test_one_broken_dataset_does_not_stop_other_tasks(self):
        collector=module.Collector({"broken":(60,Mock(side_effect=TimeoutError)),"ticker":(60,lambda:[("ticker",self.good)])},persist=Mock(),now=lambda:self.now)
        status=collector.cycle()
        self.assertTrue(status["datasets"]["ticker"]["fresh"])
        self.assertFalse(status["datasets"]["broken"]["fresh"])

    def test_wrong_domain_and_mismatched_league_rejected(self):
        for key,payload in [("arbitrary",self.good),("center:kl04:latest",{**self.good,"league":{"key":"kk11"},"standings":[{}]}),("training:32751",{**self.good,"event":{"id":123}})]:
            with self.assertRaises(ValueError):
                module.verified_payload(key,payload,self.now)

    def test_api_reads_are_disabled_by_default(self):
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"0"}),patch.object(module,"load_snapshot") as load:
            self.assertIsNone(module.collected_snapshot("ticker",90,self.now))
            load.assert_not_called()

    def test_api_sees_new_collection_without_restart_and_old_collection_is_dated(self):
        payload={**self.good,"sourceConnection":"collector"}
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1"}),patch.object(module,"load_snapshot",return_value=payload) as load:
            self.assertEqual(module.collected_snapshot("ticker",90,self.now),payload)
            load.assert_called_with("collector:ticker")
            old=module.collected_snapshot("ticker",90,self.now+timedelta(minutes=3))
            self.assertTrue(old["stale"])
            self.assertEqual(old["updatedAt"],payload["updatedAt"])
            load.return_value={**payload,"updatedAt":(self.now+timedelta(minutes=3)).isoformat(),"items":[{"id":2}]}
            self.assertEqual(module.collected_snapshot("ticker",90,self.now+timedelta(minutes=3))["items"],[{"id":2}])

    def test_actual_api_reader_ignores_old_process_cache_and_sees_next_snapshot(self):
        payload={**self.good,"sourceConnection":"collector"}
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1"}), \
             patch.object(module,"load_snapshot",return_value=payload) as load, \
             patch.object(feed,"_load",side_effect=AssertionError("upstream must not run")), \
             patch.object(feed,"_cache",{"items":[{"id":99}]}), \
             patch.object(feed,"_cache_time",self.now.timestamp()):
            self.assertEqual(feed.get_darts_feed(self.now)["items"],[{"id":1}])
            load.return_value={**payload,"items":[{"id":2}]}
            self.assertEqual(feed.get_darts_feed(self.now)["items"],[{"id":2}])
            old=feed.get_darts_feed(self.now+timedelta(minutes=7))
            self.assertTrue(old["stale"])
            self.assertEqual(old["updatedAt"],self.good["updatedAt"])

    def test_collected_latest_round_also_serves_explicit_selection(self):
        payload={**self.good,"sourceConnection":"collector","league":{"key":"kl04"},"selectedRound":{"id":34272}}
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1"}), \
             patch.object(module,"load_snapshot",return_value=payload), \
             patch.object(feed,"PublicSession",side_effect=AssertionError("upstream must not run")):
            self.assertEqual(feed.get_darts_center("kl04",34272,self.now),payload)
            with self.assertRaises(ValueError):
                feed.get_darts_center("arbitrary",34272,self.now)
            # Other rounds still pass through the original source validation.
            with self.assertRaises(AssertionError):
                feed.get_darts_center("kl04",123,self.now)

    def test_profiles_training_and_ranking_read_shared_collector_data(self):
        payloads={
            "collector:season":{**self.good,"sourceConnection":"collector","teams":[{"code":"A"}]},
            "collector:player-stats":{**self.good,"sourceConnection":"collector","players":{"42":{"name":"Player"}}},
            "collector:training:32751":{**self.good,"sourceConnection":"collector","event":{"id":32751}},
            "collector:ranking":{**self.good,"sourceConnection":"collector","rows":[{"name":"Player"}]},
        }
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1"}), \
             patch.object(module,"load_snapshot",side_effect=payloads.get), \
             patch.object(module,"datetime",wraps=datetime) as clock, \
             patch.object(feed,"_load_season",side_effect=AssertionError), \
             patch.object(feed,"_load_player_stats",side_effect=AssertionError), \
             patch.object(training,"_detail",side_effect=AssertionError), \
             patch.object(ranking,"_public_get",side_effect=AssertionError):
            clock.now.return_value=self.now
            self.assertEqual(feed.get_darts_season(self.now)["teams"],[{"code":"A"}])
            self.assertIn("42",feed.get_darts_player_stats(self.now)["players"])
            self.assertEqual(training.get_training(32751)["event"]["id"],32751)
            self.assertEqual(ranking.get_darts_ranking(self.now)["rows"],[{"name":"Player"}])

    def test_cli_dry_run_cannot_write_implicit_visitor_snapshots(self):
        def loader():
            resilience.save_snapshot("ticker",self.good)
            return [("ticker",self.good)]
        with patch.dict(os.environ,{},clear=True), \
             patch.object(module,"tasks",return_value={"ticker":(60,loader)}), \
             patch.object(module,"Collector",wraps=lambda tasks,**kwargs:module_collector(tasks,now=lambda:self.now,**kwargs)), \
             patch.object(resilience,"snapshot_connection",side_effect=AssertionError("no database access")), \
             patch.object(module,"persist_dataset",side_effect=AssertionError("no database write")), \
             patch.object(module,"write_status") as write, \
             patch("sys.argv",["darts_collector.py","--once","--dry-run","--only","ticker"]), \
             patch("builtins.print"):
            self.assertEqual(module.main(),0)
            self.assertEqual(write.call_args.args[1]["mode"],"dry-run")

    def test_strict_writer_uses_separate_namespace_and_monotonic_database_guard(self):
        connection=Mock()
        connection.__enter__=Mock(return_value=connection)
        connection.__exit__=Mock(return_value=False)
        cursor=Mock()
        cursor.__enter__=Mock(return_value=cursor)
        cursor.__exit__=Mock(return_value=False)
        connection.cursor.return_value=cursor
        with patch.object(module,"snapshot_connection",return_value=connection):
            module.persist_dataset("ticker",self.good)
        statement,args=cursor.execute.call_args.args
        self.assertEqual(args[0],"collector:ticker")
        self.assertIn("EXCLUDED.observed_at >= darts_feed_snapshots.observed_at",statement)

    def test_live_data_is_collected_faster_and_expires_sooner(self):
        loader=Mock(return_value=[("ticker",{**self.good,"items":[{"kind":"live"}]})])
        collector=module.Collector({"ticker":(300,loader)},persist=Mock(),clock=lambda:self.clock,now=lambda:self.now)
        status=collector.cycle()
        self.assertEqual(status["datasets"]["ticker"]["refreshEverySeconds"],60)
        self.clock=60
        collector.cycle()
        self.assertEqual(loader.call_count,2)
        live={**self.good,"sourceConnection":"collector","items":[{"kind":"live"}]}
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1"}),patch.object(module,"load_snapshot",return_value=live):
            self.assertTrue(module.collected_snapshot("ticker",360,self.now+timedelta(minutes=3))["stale"])

    def test_expired_training_keeps_source_link_and_profiles_mark_old_stats(self):
        source="https://portal.3k-darts.com/frontend/events/5/event/32751/participants"
        payload={**self.good,"sourceConnection":"collector","source":source,"players":{"42":{"statsStale":False}}}
        with patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1"}),patch.object(module,"load_snapshot",return_value=payload):
            later=self.now+timedelta(minutes=30)
            self.assertEqual(module.collected_snapshot("training:32751",360,later)["source"],source)
            self.assertTrue(module.collected_snapshot("player-stats",960,later)["players"]["42"]["statsStale"])
            self.assertFalse(payload["players"]["42"]["statsStale"])

    def test_names_only_table_never_overwrites_an_official_table(self):
        good={**self.good,"league":{"key":"kl04"},"selectedRound":{"id":34272},
              "standings":[{"rank":1,"rankSource":"3k-placement"},{"rank":3,"rankSource":"3k-placement"}]}
        # Official placements can have gaps; the collector must preserve them.
        self.assertEqual(module.verified_payload("center:kl04:latest",good,self.now)["standings"],good["standings"])
        writer=Mock()
        bad={**good,"standings":[{"name":"Team","rank":None}]}
        status=self.collector(lambda:[("center:kl04:latest",bad)],writer).cycle()
        self.assertFalse(status["allSourcesFresh"])
        writer.assert_not_called()

    def test_unavailable_and_nested_partial_data_are_rejected(self):
        cases=[("ticker",{**self.good,"available":False}),
               ("ticker",{**self.good,"specialEventsAvailable":False}),
               ("player-stats",{**self.good,"statsSchema":1,"players":{"42":{"statsStale":True}}}),
               ("training:32751",{**self.good,"event":{"id":32751},"performancesUnavailable":True})]
        for key,payload in cases:
            with self.assertRaises(ValueError):
                module.verified_payload(key,payload,self.now)

    def test_player_stats_require_complete_report_performance_and_league_coverage(self):
        coverage = {"observedAt": self.now.isoformat(), "seasonUpdatedAt": self.now.isoformat(),
                    "seasonFresh": True, "expectedMatches": 2, "reportsLoaded": 2, "performancesLoaded": 2,
                    "expectedLeagues": ["kl04", "kk11"], "officialLeaguesLoaded": ["kl04", "kk11"]}
        good = {**self.good, "statsSchema": 1, "players": {"42": {"statsStale": False}},
                "matchesScanned": 2, "officialLeagues": ["kl04", "kk11"], "statsCoverage": coverage}
        self.assertEqual(module.verified_payload("player-stats", good, self.now)["statsCoverage"], coverage)
        cases = [{**good, "statsCoverage": {**coverage, **partial}} for partial in (
            {"reportsLoaded": 1}, {"performancesLoaded": 1}, {"seasonFresh": False},
            {"officialLeaguesLoaded": ["kl04"]}, {"expectedMatches": True},
            {"observedAt": (self.now-timedelta(seconds=1)).isoformat()},
            {"seasonUpdatedAt": (self.now-timedelta(minutes=10)).isoformat()})]
        cases.append({**good, "statsCoverage": None})
        writer = Mock()
        for payload in cases:
            collector = module.Collector({"player-stats": (900, lambda: [("player-stats", payload)])},
                                         persist=writer, now=lambda: self.now)
            self.assertFalse(collector.cycle()["allSourcesFresh"])
        writer.assert_not_called()

    def test_stats_task_rejects_stale_season_before_aggregating(self):
        with patch.object(feed, "get_darts_season", return_value={"stale": True}), \
             patch.object(feed, "_load_player_stats") as load:
            _, loader = module.tasks()["player-stats"]
            with self.assertRaises(ValueError):
                loader()
        load.assert_not_called()

    def test_stats_task_refreshes_aged_season_when_schedules_drift(self):
        old = {"updatedAt": (self.now-timedelta(minutes=4)).isoformat()}
        fresh = {"updatedAt": self.now.isoformat()}
        with patch.object(module, "datetime", wraps=datetime) as clock, \
             patch.object(module, "verified_payload", return_value=fresh) as verify, \
             patch.object(feed, "get_darts_season", return_value=old), \
             patch.object(feed, "_load_season", return_value=fresh) as refresh, \
             patch.object(feed, "_load_player_stats", return_value={}) as load, \
             patch.object(feed, "_season_cache", None):
            clock.now.return_value = self.now
            _, loader = module.tasks()["player-stats"]
            self.assertEqual(loader(), [("player-stats", {})])
            self.assertEqual(feed._season_cache, (self.now.timestamp(), fresh))
        refresh.assert_called_once_with(self.now)
        verify.assert_called_once_with("season", fresh, self.now)
        load.assert_called_once_with(self.now)

    def test_stats_task_never_seeds_a_partial_season_refresh(self):
        old = {"updatedAt": (self.now-timedelta(minutes=4)).isoformat()}
        with patch.object(module, "datetime", wraps=datetime) as clock, \
             patch.object(feed, "get_darts_season", return_value=old), \
             patch.object(feed, "_load_season", return_value={"stale": True}), \
             patch.object(feed, "_load_player_stats") as load, \
             patch.object(feed, "_season_cache", None):
            clock.now.return_value = self.now
            _, loader = module.tasks()["player-stats"]
            with self.assertRaises(ValueError):
                loader()
            self.assertIsNone(feed._season_cache)
        load.assert_not_called()


module_collector=module.Collector


if __name__ == "__main__":
    unittest.main()
