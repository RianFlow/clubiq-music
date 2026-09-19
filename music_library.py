"""Member-owned favorites and a bounded, URL-free playback journal."""
import json
import re
from datetime import date, datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field


class Favorite(BaseModel):
    external_id: str = Field(pattern=r"^[A-Za-z0-9_-]{6,20}$")
    title: str = Field(min_length=1, max_length=255)
    channel_title: str = Field(default="", max_length=255)
    duration_ms: int | None = Field(default=None, ge=0, le=604800000)


def duration_ms(value):
    match = re.fullmatch(r"P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", str(value))
    if not match:
        return None
    days, hours, minutes, seconds = (float(n or 0) for n in match.groups())
    return min(604800000, round((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000))


def register_library(app, db_connect, require_member, player_agent, player_enabled):
    seen = set()
    last_sync = None
    last_cleanup = None

    def collect_history():
        nonlocal seen, last_sync, last_cleanup
        if not player_enabled():
            return
        try:
            records = player_agent("GET", "/history", timeout=5).get("history", [])
            rows, ids = [], set()
            now = datetime.now(timezone.utc)
            for item in records[-500:]:
                try:
                    event_id = str(UUID(str(item["event_id"])))
                    ids.add(event_id)
                    if event_id in seen:
                        continue
                    started = datetime.fromisoformat(item["started_at"].replace("Z", "+00:00"))
                    if started.tzinfo is None or not now - timedelta(days=90) <= started <= now + timedelta(minutes=5):
                        continue
                    # Never persist expiring stream URLs, credentials or member names.
                    track = {key: str(item.get(key, ""))[:255] for key in ("title", "artist", "external_id", "source")}
                    rows.append((event_id, started, json.dumps(track)))
                except (ValueError, KeyError, TypeError, AttributeError):
                    continue
            cleanup = last_cleanup != now.date()
            if not rows and not cleanup:
                last_sync = now.isoformat()
                seen = ids
                return
            with db_connect() as conn, conn.cursor() as cur:
                if rows:
                    cur.executemany("INSERT INTO music_playback_history (event_id, started_at, track_json) VALUES (%s,%s,%s::jsonb) ON CONFLICT DO NOTHING;", rows)
                if cleanup:
                    cur.execute("DELETE FROM music_playback_history WHERE started_at < CURRENT_TIMESTAMP - INTERVAL '90 days';")
                conn.commit()
            seen, last_sync, last_cleanup = ids, now.isoformat(), now.date()
        except Exception:
            # A disconnected agent must not bring down the web app or leak URLs.
            return

    @app.get("/api/v1/music/library/favorites")
    def favorites(member=Depends(require_member)):
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT external_id,title,channel_title,duration_ms FROM music_member_favorites WHERE member_id=%s ORDER BY created_at DESC;", (member["member_id"],))
            return {"favorites": [dict(zip(("external_id", "title", "channel_title", "duration_ms"), row)) for row in cur.fetchall()]}

    @app.put("/api/v1/music/library/favorites")
    def save_favorite(item: Favorite, member=Depends(require_member)):
        if not item.title.strip():
            raise HTTPException(422, "Ein Songtitel fehlt.")
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT member_id FROM club_members WHERE member_id=%s FOR UPDATE;", (member["member_id"],))
            cur.execute("SELECT COUNT(*), COALESCE(BOOL_OR(external_id=%s),false) FROM music_member_favorites WHERE member_id=%s;", (item.external_id, member["member_id"]))
            count, exists = cur.fetchone()
            if count >= 200 and not exists:
                raise HTTPException(409, "Du hast bereits 200 Favoriten. Entferne zuerst einen alten Favoriten.")
            cur.execute("""INSERT INTO music_member_favorites (member_id,external_id,title,channel_title,duration_ms)
                VALUES (%s,%s,%s,%s,%s) ON CONFLICT (member_id,external_id) DO NOTHING;""",
                        (member["member_id"], item.external_id, item.title.strip(), item.channel_title, item.duration_ms))
            conn.commit()
        return {"ok": True}

    @app.delete("/api/v1/music/library/favorites/{external_id}")
    def delete_favorite(external_id: str, member=Depends(require_member)):
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM music_member_favorites WHERE member_id=%s AND external_id=%s;", (member["member_id"], external_id))
            conn.commit()
        return {"ok": True}

    @app.get("/api/v1/music/library/history")
    def history(day: date | None = Query(default=None), member=Depends(require_member)):
        zone = ZoneInfo("Europe/Berlin")
        selected = day or datetime.now(zone).date()
        start = datetime.combine(selected, datetime.min.time(), tzinfo=zone)
        end = datetime.combine(selected + timedelta(days=1), datetime.min.time(), tzinfo=zone)
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT event_id,started_at,track_json FROM music_playback_history WHERE started_at >= %s AND started_at < %s ORDER BY started_at DESC LIMIT 201;", (start, end))
            rows = cur.fetchall()
        return {"day": str(selected), "last_sync": last_sync, "truncated": len(rows) > 200, "history": [
            {**row[2], "event_id": str(row[0]), "started_at": row[1].isoformat()} for row in rows[:200]]}

    return collect_history
