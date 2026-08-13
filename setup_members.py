import psycopg

conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

create_members_sql = """
CREATE TABLE IF NOT EXISTS club_members (
    id SERIAL PRIMARY KEY,
    member_id VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
"""

def setup_members():
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                cur.execute(create_members_sql)
                conn.commit()
                print("Tabelle 'club_members' erfolgreich erstellt!")
    except Exception as e:
        print(f"Fehler beim Erstellen der Mitglieder-Tabelle: {e}")

if __name__ == "__main__":
    setup_members()