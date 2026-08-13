import os


def connection_kwargs() -> dict[str, str | int]:
    password = os.getenv("DB_PASSWORD")
    if not password:
        raise RuntimeError("DB_PASSWORD ist nicht gesetzt.")

    return {
        "dbname": os.getenv("DB_NAME", "music_voting"),
        "user": os.getenv("DB_USER", "clubiq_music"),
        "password": password,
        "host": os.getenv("DB_HOST", "db"),
        "port": int(os.getenv("DB_PORT", "5432")),
    }
