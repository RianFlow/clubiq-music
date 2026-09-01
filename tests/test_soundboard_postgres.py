"""Real migration check, opt-in against an isolated test PostgreSQL instance."""
import os
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql

from bootstrap import SCHEMA_SQL
from db_config import connection_kwargs
from soundboard_pack import seed_soundboard


@unittest.skipUnless(os.getenv("SOUNDBOARD_TEST_POSTGRES") == "1", "isolated PostgreSQL required")
class SoundboardMigrationTests(unittest.TestCase):
    def test_old_uploads_survive_seed_rerun_and_hidden_sounds_stay_hidden(self):
        with psycopg.connect(**connection_kwargs()) as conn:
            try:
                with conn.cursor() as cur:
                    schema = sql.Identifier("soundboard_test_" + uuid4().hex)
                    cur.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
                    cur.execute(sql.SQL("SET LOCAL search_path TO {}").format(schema))
                    # Exactly the previous table shape, with a real existing upload.
                    cur.execute("""CREATE TABLE music_soundboard_items (
                        id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL,
                        media_type VARCHAR(80) NOT NULL, audio_data BYTEA NOT NULL,
                        color VARCHAR(20) NOT NULL DEFAULT 'green',
                        active BOOLEAN NOT NULL DEFAULT TRUE,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
                        INSERT INTO music_soundboard_items (name, media_type, audio_data)
                        VALUES ('Mein alter Sound', 'audio/wav', '\\x52494646');""")
                    cur.execute(SCHEMA_SQL)
                    seed_soundboard(cur)
                    cur.execute(SCHEMA_SQL)
                    seed_soundboard(cur)
                    cur.execute("SELECT count(*) FROM music_soundboard_items;")
                    self.assertEqual(cur.fetchone()[0], 33)
                    cur.execute("SELECT name, audio_data, category FROM music_soundboard_items WHERE id=1;")
                    self.assertEqual(cur.fetchone(), ("Mein alter Sound", b"RIFF", "Eigene"))
                    cur.execute("UPDATE music_soundboard_items SET active=FALSE WHERE builtin_key='clubiq-v1-180';")
                    seed_soundboard(cur)
                    cur.execute("SELECT count(*) FROM music_soundboard_items WHERE active=TRUE;")
                    self.assertEqual(cur.fetchone()[0], 32)
            finally:
                # No fixture data/schema survives, even if an assertion fails.
                conn.rollback()
