import psycopg

conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

create_cycles_sql = """
CREATE TABLE IF NOT EXISTS music_cycles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    profile_id INTEGER REFERENCES music_profiles(id),
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
    closes_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) DEFAULT 'planned',
    voting_model VARCHAR(50) DEFAULT 'points',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
"""

def setup_cycles():
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                cur.execute(create_cycles_sql)
                conn.commit()
                print("Tabelle 'music_cycles' wurde erfolgreich erstellt!")
    except Exception as e:
        print(f"Fehler: {e}")

if __name__ == "__main__":
    setup_cycles()
    