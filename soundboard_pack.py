"""Idempotent installation of bundled sounds; never overwrite user changes."""
import hashlib
import json
from pathlib import Path

PACK_DIR = Path(__file__).resolve().parent / "soundpack"
CATEGORIES = ("Darts", "Jubel", "Spaß", "Eigene")


def seed_soundboard(cursor, directory=PACK_DIR):
    items = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    # Includes hidden entries so an intentionally removed button stays removed.
    cursor.execute("SELECT builtin_key FROM music_soundboard_items WHERE builtin_key IS NOT NULL;")
    installed = {row[0] for row in cursor.fetchall()}
    for item in items:
        if item["key"] in installed:
            continue
        path = directory / item["file"]
        if path.name != item["file"] or path.suffix != ".wav":
            raise ValueError("Invalid sound pack path")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise ValueError(f"Sound pack checksum mismatch: {path.name}")
        cursor.execute(
            """INSERT INTO music_soundboard_items
               (builtin_key, name, category, media_type, audio_data, color, duration_ms)
               VALUES (%s, %s, %s, 'audio/wav', %s, %s, %s)
               ON CONFLICT (builtin_key) DO NOTHING;""",
            (item["key"], item["name"], item["category"], content, item["color"], item["duration_ms"]),
        )
