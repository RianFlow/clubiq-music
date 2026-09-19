"""Real PostgreSQL tests in a disposable schema, with rollback even on failure."""
import os
import unittest
from contextlib import contextmanager
from datetime import date, datetime, timezone
from uuid import uuid4

import psycopg
from psycopg import sql
from fastapi import FastAPI, HTTPException

from bootstrap import SCHEMA_SQL
from db_config import connection_kwargs
from music_library import Favorite, register_library


@unittest.skipUnless(os.getenv('ARCHIVE_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class LibraryPostgresTests(unittest.TestCase):
    def setUp(self):
        self.conn = psycopg.connect(**connection_kwargs())
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        with self.conn.cursor() as cur:
            schema = sql.Identifier('library_test_' + uuid4().hex)
            cur.execute(sql.SQL('CREATE SCHEMA {}').format(schema))
            cur.execute(sql.SQL('SET LOCAL search_path TO {}').format(schema))
            cur.execute(SCHEMA_SQL)
            cur.execute(SCHEMA_SQL)
            cur.execute("INSERT INTO club_members (member_id,display_name,pin_hash) VALUES ('alice','Alice','fixture'),('bob','Bob','fixture');")
        outer = self
        class Session:
            def cursor(self): return outer.conn.cursor()
            def commit(self): pass
        @contextmanager
        def connect(): yield Session()
        self.records = []
        app = FastAPI()
        self.collect = register_library(app, connect, lambda: None, lambda *a, **kw: {'history':self.records}, lambda:True)
        self.routes = {(route.path, next(iter(route.methods))):route.endpoint for route in app.routes if '/library/' in route.path}
        self.alice, self.bob = {'member_id':'alice'}, {'member_id':'bob'}

    def endpoint(self, suffix, method='GET'):
        return self.routes[('/api/v1/music/library/' + suffix, method)]

    def test_member_favorites_isolation_idempotency_and_delete(self):
        save, get = self.endpoint('favorites','PUT'), self.endpoint('favorites')
        favorite = Favorite(external_id='aaaaaaaaaaa',title='Song')
        save(favorite,self.alice); save(favorite,self.alice)
        self.assertEqual(len(get(self.alice)['favorites']),1)
        self.assertEqual(get(self.bob)['favorites'],[])
        self.endpoint('favorites/{external_id}','DELETE')('aaaaaaaaaaa',self.bob)
        self.assertEqual(len(get(self.alice)['favorites']),1)
        self.endpoint('favorites/{external_id}','DELETE')('aaaaaaaaaaa',self.alice)
        self.assertEqual(get(self.alice)['favorites'],[])

    def test_cap_and_cascade(self):
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO music_member_favorites(member_id,external_id,title) SELECT 'alice','song'||n,'Song' FROM generate_series(1,200) n;")
        with self.assertRaises(HTTPException) as exc:
            self.endpoint('favorites','PUT')(Favorite(external_id='bbbbbbbbbbb',title='Song'),self.alice)
        self.assertEqual(exc.exception.status_code,409)
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM club_members WHERE member_id='alice';")
            cur.execute('SELECT count(*) FROM music_member_favorites;')
            self.assertEqual(cur.fetchone()[0],0)

    def test_collector_idempotency_sanitization_and_retention(self):
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO music_playback_history VALUES (%s, CURRENT_TIMESTAMP - INTERVAL '91 days', '{}');", (uuid4(),))
        self.records = [{'event_id':str(uuid4()),'started_at':datetime.now(timezone.utc).isoformat(),
                         'title':'Song','external_id':'aaaaaaaaaaa','source':'youtube','url':'secret-stream'}, {'broken':True}]
        self.collect(); self.collect()
        with self.conn.cursor() as cur:
            cur.execute('SELECT track_json FROM music_playback_history;')
            rows = cur.fetchall()
            self.assertEqual(len(rows),1)
            self.assertNotIn('url',rows[0][0])
        response = self.endpoint('history')(day=None,member=self.alice)
        self.assertEqual(len(response['history']),1)
        self.assertIsNotNone(response['last_sync'])

    def test_berlin_day_includes_dst_boundaries(self):
        with self.conn.cursor() as cur:
            for when in ('2026-10-24T22:00:00+00:00','2026-10-25T22:59:59+00:00','2026-10-25T23:00:00+00:00'):
                cur.execute("INSERT INTO music_playback_history VALUES (%s,%s,'{}');",(uuid4(),when))
        response = self.endpoint('history')(day=date(2026,10,25),member=self.alice)
        self.assertEqual(len(response['history']),2)
