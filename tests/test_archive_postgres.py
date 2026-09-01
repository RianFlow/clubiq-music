"""Archive lifecycle against real PostgreSQL, isolated in a rolled-back schema."""
import os
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from fastapi import HTTPException

import main
from bootstrap import SCHEMA_SQL
from db_config import connection_kwargs


@unittest.skipUnless(os.getenv("ARCHIVE_TEST_POSTGRES") == "1", "isolated PostgreSQL required")
class ArchivePostgresTests(unittest.TestCase):
    def setUp(self):
        self.conn = psycopg.connect(**connection_kwargs())
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        with self.conn.cursor() as cur:
            schema = sql.Identifier("archive_test_" + uuid4().hex)
            cur.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
            cur.execute(sql.SQL("SET LOCAL search_path TO {}").format(schema))
            cur.execute(SCHEMA_SQL)
            # Migration from the prior table shape, preserving an existing list.
            cur.execute("INSERT INTO music_cycles (id, name, status, starts_at, closes_at, reuse_previous_playlist, genre_fallback_enabled, playlist_target_count) VALUES (1, 'Vereinsabend', 'active', CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '1 day', FALSE, TRUE, 3);")
            cur.execute("ALTER TABLE music_cycle_playlists DROP COLUMN finalized_at;")
            cur.execute("INSERT INTO music_cycle_playlists (cycle_id, items_json) VALUES (1, '[]');")
            cur.execute(SCHEMA_SQL)
            cur.execute(SCHEMA_SQL)
            cur.execute("SELECT count(*) FROM music_cycle_playlists WHERE cycle_id=1 AND finalized_at IS NULL;")
            self.assertEqual(cur.fetchone()[0], 1)
            cur.execute("INSERT INTO music_suggestions (id, cycle_id, member_id, provider, external_id, title) VALUES (1, 1, 'dj', 'youtube', 'aaaaaaaaaaa', 'Titel A'), (2, 1, 'dj', 'youtube', 'bbbbbbbbbbb', 'Titel B');")
            cur.execute("INSERT INTO music_votes (cycle_id, suggestion_id, member_id, points) VALUES (1, 1, 'dj', 5), (1, 2, 'dj', 1);")

        # App commit calls intentionally remain inside this test's rollback boundary.
        outer = self
        class Session:
            def cursor(self):
                return outer.conn.cursor()
            def commit(self):
                pass

        @contextmanager
        def connect():
            yield Session()

        db = patch.object(main, "db_connect", connect)
        db.start()
        self.addCleanup(db.stop)
        agent = patch.object(main, "player_agent", side_effect=lambda method, path, payload: {"queue": payload["items"]})
        self.agent = agent.start()
        self.addCleanup(agent.stop)
        genre = patch.object(main, "youtube_popular_tracks", return_value=[
            {"title": "Genre C", "artist": "", "external_id": "ccccccccccc"},
        ])
        self.genre = genre.start()
        self.addCleanup(genre.stop)
        self.dj = {"member_id": "dj", "can_control_player": True}

    def expire(self):
        with self.conn.cursor() as cur:
            cur.execute("UPDATE music_cycles SET closes_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id=1;")

    def ids(self, result):
        return [item["id"].split(":", 1)[-1] for item in result["queue"]]

    def test_final_votes_rebuild_preview_once_and_snapshot_stays_identical(self):
        preview = main.use_cycle_ranking(1, self.dj)
        self.assertEqual(self.ids(preview), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
        with self.conn.cursor() as cur:
            cur.execute("UPDATE music_votes SET points=8 WHERE suggestion_id=2;")
        self.expire()
        final = main.use_cycle_ranking(1, self.dj)
        self.assertEqual(self.ids(final), ['bbbbbbbbbbb', 'aaaaaaaaaaa', 'ccccccccccc'])
        self.assertTrue(final["playlist_build"]["archived"])
        self.genre.reset_mock()
        self.genre.return_value = [{"title": "Other genre", "external_id": "ddddddddddd"}]
        replay = main.use_cycle_ranking(1, self.dj)
        self.assertEqual(replay["queue"], final["queue"])
        self.genre.assert_not_called()
        self.assertEqual(main.get_playlist(1, self.dj)["playlist"][0]["title"], "Titel B")
        with self.assertRaises(HTTPException) as error:
            main.cast_vote(1, main.VoteCreate(suggestion_id=1, points=2), self.dj)
        self.assertEqual(error.exception.status_code, 409)

    def test_current_falls_back_to_closed_and_explicit_id_is_not_replaced_by_new_active(self):
        self.expire()
        self.assertEqual(main.use_current_ranking(self.dj)["playlist_build"]["cycle_id"], 1)
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO music_cycles (id, name, status, starts_at, closes_at) VALUES (2, 'Neu', 'active', CURRENT_TIMESTAMP - INTERVAL '1 second', CURRENT_TIMESTAMP + INTERVAL '1 day');")
        self.assertEqual(main.use_current_ranking(self.dj)["playlist_build"]["cycle_id"], 2)
        self.assertEqual(main.use_cycle_ranking(1, self.dj)["playlist_build"]["cycle_id"], 1)

    def test_future_cycle_and_missing_cycle_do_not_touch_player(self):
        with self.conn.cursor() as cur:
            cur.execute("UPDATE music_cycles SET status='planned', starts_at=CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE id=1;")
        for cycle_id, status in [(1, 409), (999, 404)]:
            with self.assertRaises(HTTPException) as error:
                main.use_cycle_ranking(cycle_id, self.dj)
            self.assertEqual(error.exception.status_code, status)
        self.agent.assert_not_called()

    def test_reopening_allows_new_final_result(self):
        self.expire()
        main.use_cycle_ranking(1, self.dj)
        main.update_cycle(1, main.CycleUpdate(status="active", closes_at=datetime.now(timezone.utc) + timedelta(days=1)))
        with self.conn.cursor() as cur:
            cur.execute("SELECT finalized_at FROM music_cycle_playlists WHERE cycle_id=1;")
            self.assertIsNone(cur.fetchone()[0])
            cur.execute("UPDATE music_votes SET points=8 WHERE suggestion_id=2;")
        self.expire()
        self.assertEqual(self.ids(main.use_cycle_ranking(1, self.dj))[0], 'bbbbbbbbbbb')

    def test_previous_songs_are_available_with_and_without_saved_playlist(self):
        self.expire()
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO music_cycles (id, name, status, starts_at, closes_at) VALUES (2, 'Neue Runde', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day');")
        candidates = main.get_previous_playlist(2)
        self.assertEqual(candidates["cycle"]["id"], 1)
        self.assertEqual([song["external_id"] for song in candidates["songs"]], ['aaaaaaaaaaa', 'bbbbbbbbbbb'])
        self.assertEqual(main.get_playlist(2, None)["playlist"], [])
        main.use_cycle_ranking(1, self.dj)
        candidates = main.get_previous_playlist(2)
        self.assertEqual([song["external_id"] for song in candidates["songs"]], ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
        main.create_suggestion(2, main.SuggestionCreate(provider="youtube", external_id="aaaaaaaaaaa", title="Titel A"), self.dj)
        new_song = main.get_playlist(2, self.dj)["playlist"][0]
        self.assertEqual(new_song["total_points"], 0)
        self.assertEqual(new_song["my_points"], 0)
