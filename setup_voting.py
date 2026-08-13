import psycopg

conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

create_voting_tables_sql = """
-- 1. Tabelle für Song-Vorschläge in einem Zyklus
CREATE TABLE IF NOT EXISTS music_suggestions (
    id SERIAL PRIMARY KEY,
    cycle_id INTEGER REFERENCES music_cycles(id) ON DELETE CASCADE,
    member_id VARCHAR(100) NOT NULL, -- Wer hat ihn vorgeschlagen?
    provider VARCHAR(50) NOT NULL,
    external_id VARCHAR(100) NOT NULL, -- z.B. YouTube Video-ID
    title VARCHAR(255) NOT NULL,
    channel_title VARCHAR(255),
    duration_ms INTEGER,
    status VARCHAR(50) DEFAULT 'approved', -- 'approved', 'rejected', etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabelle für die abgegebenen Punkte-Votes der Mitglieder
CREATE TABLE IF NOT EXISTS music_votes (
    id SERIAL PRIMARY KEY,
    cycle_id INTEGER REFERENCES music_cycles(id) ON DELETE CASCADE,
    suggestion_id INTEGER REFERENCES music_suggestions(id) ON DELETE CASCADE,
    member_id VARCHAR(100) NOT NULL,
    points INTEGER NOT NULL CHECK (points > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Jedes Mitglied darf pro Song in einem Zyklus nur einmal abstimmen
    CONSTRAINT unique_member_suggestion_vote UNIQUE (cycle_id, suggestion_id, member_id)
);
"""

def setup_voting_tables():
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                cur.execute(create_voting_tables_sql)
                conn.commit()
                print("Tabellen 'music_suggestions' und 'music_votes' erfolgreich erstellt!")
    except Exception as e:
        print(f"Fehler beim Erstellen der Voting-Tabellen: {e}")

if __name__ == "__main__":
    setup_voting_tables()