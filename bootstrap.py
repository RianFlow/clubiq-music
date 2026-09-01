import time

import psycopg

from db_config import connection_kwargs
from soundboard_pack import seed_soundboard


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS music_profiles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    version INTEGER DEFAULT 1,
    rules_json JSONB,
    target_track_count INTEGER,
    target_duration_minutes INTEGER,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_cycles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'weekly',
    profile_id INTEGER REFERENCES music_profiles(id),
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closes_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    status VARCHAR(50) DEFAULT 'active',
    voting_model VARCHAR(50) DEFAULT 'points',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS club_members (
    id SERIAL PRIMARY KEY,
    member_id VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    pin_hash TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    can_control_player BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_member_sessions (
    id BIGSERIAL PRIMARY KEY,
    member_id VARCHAR(100) NOT NULL REFERENCES club_members(member_id) ON DELETE CASCADE,
    token_hash CHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_suggestions (
    id SERIAL PRIMARY KEY,
    cycle_id INTEGER REFERENCES music_cycles(id) ON DELETE CASCADE,
    member_id VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL DEFAULT 'youtube',
    external_id VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    channel_title VARCHAR(255),
    duration_ms INTEGER,
    status VARCHAR(50) DEFAULT 'approved',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_votes (
    id SERIAL PRIMARY KEY,
    cycle_id INTEGER REFERENCES music_cycles(id) ON DELETE CASCADE,
    suggestion_id INTEGER REFERENCES music_suggestions(id) ON DELETE CASCADE,
    member_id VARCHAR(100) NOT NULL,
    points INTEGER NOT NULL CHECK (points > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_member_suggestion_vote UNIQUE (cycle_id, suggestion_id, member_id)
);

CREATE TABLE IF NOT EXISTS music_provider_search_cache (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    normalized_query VARCHAR(255) NOT NULL,
    market VARCHAR(10) NOT NULL,
    result_json JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    hit_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS music_soundboard_items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    media_type VARCHAR(80) NOT NULL,
    audio_data BYTEA NOT NULL,
    color VARCHAR(20) NOT NULL DEFAULT 'green',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE music_soundboard_items ADD COLUMN IF NOT EXISTS builtin_key VARCHAR(80) UNIQUE;
ALTER TABLE music_soundboard_items ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'Eigene';
ALTER TABLE music_soundboard_items ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

CREATE TABLE IF NOT EXISTS music_player_audit (
    id BIGSERIAL PRIMARY KEY,
    member_id VARCHAR(100),
    action VARCHAR(40) NOT NULL,
    detail_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_cycle_playlists (
    cycle_id INTEGER PRIMARY KEY REFERENCES music_cycles(id) ON DELETE CASCADE,
    items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_radio_stations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    stream_url TEXT NOT NULL,
    fallback_url TEXT,
    logo_url TEXT,
    genre VARCHAR(80),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_search_cache_lookup
ON music_provider_search_cache (provider, normalized_query, market, expires_at);

CREATE INDEX IF NOT EXISTS idx_music_member_sessions_token
ON music_member_sessions (token_hash, expires_at);

CREATE INDEX IF NOT EXISTS idx_music_player_audit_created
ON music_player_audit (created_at DESC);

ALTER TABLE club_members ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE club_members ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE club_members ADD COLUMN IF NOT EXISTS can_control_player BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE music_cycles ADD COLUMN IF NOT EXISTS max_budget INTEGER;
UPDATE music_cycles SET max_budget = 10 WHERE max_budget IS NULL;
ALTER TABLE music_cycles ALTER COLUMN max_budget SET DEFAULT 10;
ALTER TABLE music_cycles ALTER COLUMN max_budget SET NOT NULL;
ALTER TABLE music_cycles ADD COLUMN IF NOT EXISTS playlist_target_count INTEGER;
UPDATE music_cycles SET playlist_target_count = 20 WHERE playlist_target_count IS NULL;
ALTER TABLE music_cycles ALTER COLUMN playlist_target_count SET DEFAULT 20;
ALTER TABLE music_cycles ALTER COLUMN playlist_target_count SET NOT NULL;
ALTER TABLE music_cycles ADD COLUMN IF NOT EXISTS reuse_previous_playlist BOOLEAN;
UPDATE music_cycles SET reuse_previous_playlist = TRUE WHERE reuse_previous_playlist IS NULL;
ALTER TABLE music_cycles ALTER COLUMN reuse_previous_playlist SET DEFAULT TRUE;
ALTER TABLE music_cycles ALTER COLUMN reuse_previous_playlist SET NOT NULL;
ALTER TABLE music_cycles ADD COLUMN IF NOT EXISTS genre_fallback_enabled BOOLEAN;
UPDATE music_cycles SET genre_fallback_enabled = TRUE WHERE genre_fallback_enabled IS NULL;
ALTER TABLE music_cycles ALTER COLUMN genre_fallback_enabled SET DEFAULT TRUE;
ALTER TABLE music_cycles ALTER COLUMN genre_fallback_enabled SET NOT NULL;
ALTER TABLE music_cycles ADD COLUMN IF NOT EXISTS fallback_genre VARCHAR(80);
UPDATE music_cycles SET fallback_genre = 'Party' WHERE fallback_genre IS NULL;
ALTER TABLE music_cycles ALTER COLUMN fallback_genre SET DEFAULT 'Party';
ALTER TABLE music_cycles ALTER COLUMN fallback_genre SET NOT NULL;
"""

DEFAULTS_SQL = """
INSERT INTO music_profiles (id, name, slug, active)
VALUES (1, 'Standard', 'standard', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO music_cycles (
    id, name, type, profile_id, starts_at, closes_at, status
)
VALUES (
    1,
    'Aktuelles Voting',
    'weekly',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP + INTERVAL '7 days',
    'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT setval(
    pg_get_serial_sequence('music_profiles', 'id'),
    GREATEST(COALESCE((SELECT MAX(id) FROM music_profiles), 1), 1),
    true
);

SELECT setval(
    pg_get_serial_sequence('music_cycles', 'id'),
    GREATEST(COALESCE((SELECT MAX(id) FROM music_cycles), 1), 1),
    true
);
"""


def setup(max_attempts: int = 30) -> None:
    for attempt in range(1, max_attempts + 1):
        try:
            with psycopg.connect(**connection_kwargs()) as conn:
                with conn.cursor() as cur:
                    cur.execute(SCHEMA_SQL)
                    cur.execute(DEFAULTS_SQL)
                    seed_soundboard(cur)
                conn.commit()
            print("Datenbank-Initialisierung erfolgreich.")
            return
        except psycopg.OperationalError:
            if attempt == max_attempts:
                raise
            print(f"Datenbank noch nicht bereit ({attempt}/{max_attempts}).")
            time.sleep(2)


if __name__ == "__main__":
    setup()
