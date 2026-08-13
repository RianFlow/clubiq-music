import psycopg

# Unsere Zugangsdaten zur lokalen Docker-Datenbank
conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

# Der SQL-Befehl zum Erstellen der Tabelle (genau nach Spezifikation)
create_table_sql = """
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""

def setup_database():
    try:
        # Verbindung öffnen
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                # Den SQL-Befehl ausführen
                cur.execute(create_table_sql)
                # Änderungen speichern
                conn.commit()
                print("Tabelle 'music_profiles' wurde erfolgreich erstellt!")
    except Exception as e:
        print(f"Es gab einen Fehler: {e}")

if __name__ == "__main__":
    setup_database()