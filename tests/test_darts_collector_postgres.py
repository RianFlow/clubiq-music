"""Opt-in collector integration test, run against a disposable test database only."""
from datetime import datetime, timezone, timedelta
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql

import darts_collector as collector
import darts_feed as feed
import darts_resilience as resilience
from db_config import connection_kwargs


@unittest.skipUnless(os.getenv("DARTS_COLLECTOR_TEST_POSTGRES") == "1", "disposable PostgreSQL required")
class CollectorPostgresTests(unittest.TestCase):
    def test_shared_data_updates_without_restart_and_never_regresses(self):
        name="collector_test_"+uuid4().hex
        schema=sql.Identifier(name)
        with psycopg.connect(**connection_kwargs()) as conn:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
                    cursor.execute(sql.SQL("SET LOCAL search_path TO {}").format(schema))
                    cursor.execute("CREATE TABLE darts_feed_snapshots (cache_key TEXT PRIMARY KEY,payload JSONB NOT NULL,observed_at TIMESTAMPTZ NOT NULL)")
                conn.commit()
                def connect():
                    return psycopg.connect(**connection_kwargs(),options=f"-c search_path={name}")
                now=datetime.now(timezone.utc)
                original={"updatedAt":(now-timedelta(minutes=1)).isoformat(),"items":[{"id":10}],"specialEventsAvailable":True}
                latest={"updatedAt":now.isoformat(),"items":[{"id":20}],"specialEventsAvailable":True}
                with patch.object(collector,"snapshot_connection",side_effect=connect), \
                     patch.object(resilience,"snapshot_connection",side_effect=connect), \
                     patch.dict(os.environ,{"DARTS_COLLECTOR_READ_ENABLED":"1","DARTS_SNAPSHOT_WRITES_DISABLED":"0"}), \
                     patch.object(feed,"_load",side_effect=AssertionError("API must read the database")):
                    resilience.save_snapshot("ticker",original)
                    collector.persist_dataset("ticker",collector.verified_payload("ticker",original,now))
                    self.assertEqual(feed.get_darts_feed(now)["items"],[{"id":10}])
                    collector.persist_dataset("ticker",collector.verified_payload("ticker",latest,now))
                    self.assertEqual(feed.get_darts_feed(now)["items"],[{"id":20}])
                    # A slow concurrent writer cannot replace a newer observation.
                    collector.persist_dataset("ticker",collector.verified_payload("ticker",original,now))
                    self.assertEqual(feed.get_darts_feed(now)["items"],[{"id":20}])
                    self.assertEqual(resilience.load_snapshot("ticker"),original)
                    stale=feed.get_darts_feed(now+timedelta(minutes=7))
                    self.assertTrue(stale["stale"])
                    self.assertEqual(stale["updatedAt"],latest["updatedAt"])
            finally:
                conn.rollback()
                with conn.cursor() as cursor:
                    cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(schema))
                conn.commit()
