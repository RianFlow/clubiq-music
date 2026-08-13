import psycopg

conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

insert_sql = """
INSERT INTO music_cycles (name, type, profile_id, starts_at, closes_at, status)
VALUES (%s, %s, %s, %s, %s, %s);
"""

def seed_cycles():
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                # Wir setzen den Zyklus für Anfang/Mitte August 2026 ein
                cur.execute(insert_sql, (
                    "Wochenvoting KW 33", 
                    "weekly", 
                    1, # Hier verknüpfen wir unser Profil 'Normaler Vereinsabend' (ID 1)
                    "2026-08-09 00:00:00+02", # Start: Sonntag
                    "2026-08-16 17:00:00+02", # Ende: Darauffolgender Sonntag 17:00 Uhr
                    "open" # Status: Abstimmung läuft
                ))
                conn.commit()
                print("Test-Zyklus erfolgreich in die Datenbank eingefügt!")
    except Exception as e:
        print(f"Fehler: {e}")

if __name__ == "__main__":
    seed_cycles()