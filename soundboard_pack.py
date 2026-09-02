"""Idempotent installation of bundled sounds; never overwrite user changes."""
import hashlib
import json
from pathlib import Path

PACK_DIR = Path(__file__).resolve().parent / "soundpack"
CATEGORIES = ("Darts", "Jubel", "Spaß", "Eigene")
# Exact IDs only; uploads and other packs are never touched. Keep old audio
# in the database for recovery, but retire the speech synthesis/arcade buttons.
RETIRED_KEYS = tuple("clubiq-v1-" + key for key in (
    "180", "140", "100", "60", "26", "bullseye", "checkout", "game-shot",
    "game-on", "matchdart", "double", "triple", "nine-darter", "bust", "madhouse",
    "barver", "good-darts", "warmup", "board", "maths", "almost", "next-round",
    "three-darts", "fanfare", "applause", "drumroll", "level-up", "airhorn",
    "rimshot", "trombone", "boing", "crickets",
))


def seed_soundboard(cursor, directory=PACK_DIR):
    items = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    # Includes hidden entries so an intentionally removed button stays removed.
    cursor.execute("SELECT builtin_key FROM music_soundboard_items WHERE builtin_key IS NOT NULL;")
    installed = {row[0] for row in cursor.fetchall()}
    additions = []
    # Validate all new audio before any writes, inside bootstrap's transaction.
    for item in items:
        if item["key"] in installed:
            continue
        path = directory / item["file"]
        if path.name != item["file"] or path.suffix != ".wav":
            raise ValueError("Invalid sound pack path")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != item["sha256"]:
            raise ValueError(f"Sound pack checksum mismatch: {path.name}")
        additions.append((item, content))
    for item, content in additions:
        cursor.execute(
            """INSERT INTO music_soundboard_items
               (builtin_key, name, category, media_type, audio_data, color, duration_ms)
               VALUES (%s, %s, %s, 'audio/wav', %s, %s, %s)
               ON CONFLICT (builtin_key) DO NOTHING;""",
            (item["key"], item["name"], item["category"], content, item["color"], item["duration_ms"]),
        )
    cursor.execute(
        "UPDATE music_soundboard_items SET active = FALSE WHERE builtin_key = ANY(%s) AND active = TRUE;",
        (list(RETIRED_KEYS),),
    )
