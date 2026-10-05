"""Verify durable recovery in an isolated PostgreSQL schema, opt-in only."""
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql

from bootstrap import SCHEMA_SQL
from db_config import connection_kwargs
from darts_resilience import load_snapshot, save_snapshot


@unittest.skipUnless(os.getenv("DARTS_TEST_POSTGRES") == "1", "isolated PostgreSQL required")
class SnapshotPostgresTests(unittest.TestCase):
    def test_snapshot_survives_new_connection_and_older_writer_cannot_regress_it(self):
        schema_name = "darts_snapshot_test_" + uuid4().hex
        schema = sql.Identifier(schema_name)
        with psycopg.connect(**connection_kwargs()) as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
                    cur.execute(sql.SQL("SET LOCAL search_path TO {}").format(schema))
                    cur.execute(SCHEMA_SQL)
                    cur.execute(SCHEMA_SQL)
                conn.commit()
                def connect():
                    return psycopg.connect(**connection_kwargs(), options=f"-c search_path={schema_name}")
                good = {"updatedAt": "2026-10-05T12:00:00+00:00", "items": [{"id": 42, "score": "8:4"}]}
                with patch("darts_resilience.snapshot_connection", side_effect=connect):
                    save_snapshot("ticker", good)
                    self.assertEqual(load_snapshot("ticker"), good)
                    save_snapshot("ticker", {**good, "updatedAt": "2026-10-04T12:00:00+00:00", "items": []})
                    self.assertEqual(load_snapshot("ticker"), good)
                    save_snapshot("ticker", {**good, "stale": True, "items": []})
                    self.assertEqual(load_snapshot("ticker"), good)
                    self.assertIsNone(load_snapshot("center:kk11:999"))
            finally:
                conn.rollback()
                with conn.cursor() as cur:
                    cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(schema))
                conn.commit()
