import psycopg

conn_info = "dbname=music_voting_dev user=clubiq_dev password=devpassword host=localhost port=5432"

create_cache_table_sql = """
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

CREATE INDEX IF NOT EXISTS idx_search_cache_lookup 
ON music_provider_search_cache (provider, normalized_query, market, expires_at);
"""

def setup_cache():
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                cur.execute(create_cache_table_sql)
                conn.commit()
                print("Tabelle 'music_provider_search_cache' und Indizes erfolgreich erstellt!")
    except Exception as e:
        print(f"Fehler beim Erstellen der Cache-Tabelle: {e}")

if __name__ == "__main__":
    setup_cache()