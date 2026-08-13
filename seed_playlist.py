import psycopg

conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

def seed_test_data():
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                # 1. Wir fügen ein paar Test-Songs für unseren Zyklus (ID 1) ein
                suggestions = [
                    (1, "mitglied_1", "youtube", "dQw4w9WgXcQ", "Never Gonna Give You Up", "Rick Astley", 213000),
                    (1, "mitglied_2", "youtube", "abc123xyz", "Thunderstruck", "AC/DC", 292000),
                    (1, "mitglied_3", "youtube", "xyz789abc", "Eye of the Tiger", "Survivor", 245000),
                ]
                
                suggestion_ids = []
                for s in suggestions:
                    cur.execute("""
                        INSERT INTO music_suggestions (cycle_id, member_id, provider, external_id, title, channel_title, duration_ms)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        RETURNING id;
                    """, s)
                    suggestion_ids.append(cur.fetchone()[0])
                
                # 2. Wir verteilen ein paar Test-Punkte darauf
                votes = [
                    (1, suggestion_ids[0], "mitglied_1", 5),  # Rick Astley kriegt 5 Punkte
                    (1, suggestion_ids[0], "mitglied_2", 8),  # Rick Astley kriegt nochmal 8 Punkte (Gesamt: 13)
                    (1, suggestion_ids[1], "mitglied_1", 10), # AC/DC kriegt 10 Punkte (Gesamt: 10)
                    (1, suggestion_ids[2], "mitglied_3", 3),  # Survivor kriegt 3 Punkte (Gesamt: 3)
                ]
                
                for v in votes:
                    cur.execute("""
                        INSERT INTO music_votes (cycle_id, suggestion_id, member_id, points)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (cycle_id, suggestion_id, member_id) 
                        DO UPDATE SET points = EXCLUDED.points;
                    """, v)
                
                conn.commit()
                print("Test-Songs und Votes wurden erfolgreich eingefügt!")
                
    except Exception as e:
        print(f"Fehler beim Befüllen: {e}")

if __name__ == "__main__":
    seed_test_data()