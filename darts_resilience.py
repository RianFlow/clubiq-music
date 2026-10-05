"""Recovery for public 3K reads and durable, normalized last-good snapshots."""
from __future__ import annotations

from threading import Lock
from time import monotonic
from urllib.parse import urlsplit

import psycopg
from psycopg.types.json import Jsonb
import requests

from db_config import connection_kwargs


class SourceCoolingDown(requests.RequestException):
    pass


class PublicSourceRecovery:
    """Share bounded retries across visitors and background jobs, per 3K host."""
    def __init__(self, clock=monotonic):
        self.clock = clock
        self.lock = Lock()
        self.states = {}

    def get(self, request, url, **kwargs):
        host = urlsplit(url).hostname or ""
        with self.lock:
            state = self.states.setdefault(host, {"failures": 0, "retry": 0, "probe": False})
            if state["failures"]:
                if self.clock() < state["retry"] or state["probe"]:
                    raise SourceCoolingDown("3K-Verbindung wird automatisch erneut geprüft.")
                state["probe"] = True
        try:
            response = request(url, **kwargs)
            if response.status_code in (403, 429) or response.status_code >= 500:
                response.raise_for_status()
        except requests.RequestException:
            with self.lock:
                state["failures"] += 1
                delay = (30, 60, 120, 300)[min(state["failures"] - 1, 3)]
                state.update(retry=self.clock() + delay, probe=False)
            raise
        else:
            with self.lock:
                state.update(failures=0, retry=0, probe=False)
            return response


source_recovery = PublicSourceRecovery()


class PublicSession(requests.Session):
    def get(self, url, **kwargs):
        return source_recovery.get(super().get, url, **kwargs)


def snapshot_connection():
    return psycopg.connect(**connection_kwargs(), connect_timeout=2, options="-c statement_timeout=2000")


def save_snapshot(key: str, payload: dict) -> None:
    # Callers pass only their public normalized DTO, never raw registration data.
    if not payload.get("updatedAt") or payload.get("stale") or payload.get("degraded"):
        return
    try:
        with snapshot_connection() as conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO darts_feed_snapshots (cache_key, payload, observed_at)
                VALUES (%s, %s, %s)
                ON CONFLICT (cache_key) DO UPDATE SET
                    payload = EXCLUDED.payload, observed_at = EXCLUDED.observed_at
                WHERE EXCLUDED.observed_at >= darts_feed_snapshots.observed_at
            """, (key, Jsonb(payload), payload["updatedAt"]))
    except (psycopg.Error, RuntimeError, ValueError):
        # In-memory caching remains usable during database maintenance and tests.
        pass


def load_snapshot(key: str) -> dict | None:
    try:
        with snapshot_connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT payload FROM darts_feed_snapshots WHERE cache_key = %s", (key,))
            row = cur.fetchone()
        if row and isinstance(row[0], dict) and row[0].get("updatedAt"):
            return row[0]
    except (psycopg.Error, RuntimeError, ValueError):
        pass
    return None


def last_known(payload: dict) -> dict:
    return {**payload, "stale": True, "recovery": "automatic", "source": "last-known"}
