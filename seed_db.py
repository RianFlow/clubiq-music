import psycopg
import json

# Unsere Zugangsdaten
conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

# Der SQL-Befehl zum Einfügen. 
# "ON CONFLICT" verhindert, dass wir es doppelt anlegen, falls du das Skript zweimal startest.
insert_sql = """
INSERT INTO music_profiles (name, slug, description, rules_json, target_track_count, target_duration_minutes)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (slug) DO NOTHING;
"""

def seed_database():
    # Wir definieren die Regeln als sogenanntes JSON-Objekt
    rules = {
        "allowed_genres": ["Rock", "Pop", "Schlager"],
        "energy_level": "moderate",
        "explicit_allowed": False
    }
    
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                # Wir übergeben unsere Daten sicher an die Datenbank
                cur.execute(insert_sql, (
                    "Normaler Vereinsabend",
                    "normaler-vereinsabend",
                    "gemischt, bekannt, gesellig",
                    json.dumps(rules), # Macht aus unserem Python-Objekt echten JSON-Text
                    100, # 100 Lieder als Ziel
                    300  # 5 Stunden Dauer
                ))
                conn.commit()
                print("Test-Profil 'Normaler Vereinsabend' wurde erfolgreich eingefügt!")
    except Exception as e:
        print(f"Es gab einen Fehler: {e}")

if __name__ == "__main__":
    seed_database()