from __future__ import annotations

import hashlib
import http.client
import html
import json
import os
import re
import secrets
import socket
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID

import psycopg
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db_config import connection_kwargs
from radio_directory import DirectoryUnavailable, get_station, search_stations
from radio_logos import CACHE_SECONDS, FAILURE_SECONDS, cached_logo

load_dotenv()

DEFAULT_MAX_BUDGET = int(os.getenv("MAX_BUDGET", "10"))
DEFAULT_PLAYLIST_TARGET = max(1, min(100, int(os.getenv("PLAYLIST_TARGET_COUNT", "20"))))
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
SESSION_DAYS = max(1, int(os.getenv("SESSION_DAYS", "30")))
PLAYER_AGENT_SOCKET = os.getenv("PLAYER_AGENT_SOCKET", "/run/clubiq-music/player.sock")
PLAYER_AGENT_TOKEN = os.getenv("PLAYER_AGENT_TOKEN", "")
PLAYER_PUBLIC_BASE_URL = os.getenv("PLAYER_PUBLIC_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
BACKUP_STATUS_FILE = Path(os.getenv("MUSIC_BACKUP_STATUS_FILE", "/backups/status.json"))
PIN_ITERATIONS = 210_000
YOUTUBE_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
SOUNDBOARD_MEDIA_TYPES = {"audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/mp4"}
MAX_SOUNDBOARD_BYTES = 3 * 1024 * 1024


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 5):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def station_logo_path(station_id) -> str:
    if type(station_id) is not int or station_id <= 0:
        return "/static/radio-placeholder.svg"
    return f"/api/v1/music/radio/stations/{station_id}/logo"


def player_image_urls(state: dict) -> dict:
    station = state.get("radio_station")
    if state.get("source_mode") == "radio" and isinstance(station, dict):
        logo_path = station_logo_path(station.get("id"))
        state["radio_station"] = {**station, "logo_image_url": logo_path}
        if isinstance(state.get("current"), dict):
            state["current"] = {**state["current"], "thumbnail": logo_path}
    return state


def player_agent(method: str, path: str, payload: dict | None = None, timeout: float = 12) -> dict:
    if not PLAYER_AGENT_TOKEN:
        raise HTTPException(status_code=503, detail="Der Raspberry-Player ist noch nicht eingerichtet.")
    encoded = json.dumps(payload or {}).encode()
    connection = UnixHTTPConnection(PLAYER_AGENT_SOCKET, timeout=timeout)
    try:
        connection.request(
            method,
            path,
            body=encoded if method != "GET" else None,
            headers={"Content-Type": "application/json", "X-Player-Token": PLAYER_AGENT_TOKEN},
        )
        response = connection.getresponse()
        result = json.loads(response.read() or b"{}")
        if response.status >= 400:
            raise HTTPException(status_code=503, detail=result.get("error", "Player antwortet nicht."))
        return player_image_urls(result)
    except HTTPException:
        raise
    except (OSError, ValueError, http.client.HTTPException) as exc:
        raise HTTPException(status_code=503, detail="Der Raspberry-Player ist nicht erreichbar.") from exc
    finally:
        connection.close()


def db_connect():
    return psycopg.connect(**connection_kwargs())


def normalize_member_id(value: str) -> str:
    return "_".join(value.casefold().strip().split())[:100]


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, PIN_ITERATIONS)
    return f"pbkdf2_sha256${PIN_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_pin(pin: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        scheme, iterations, salt_hex, expected_hex = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", pin.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return secrets.compare_digest(actual.hex(), expected_hex)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Bitte erneut anmelden.")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Bitte erneut anmelden.")
    return token


def require_member(authorization: str | None = Header(default=None)) -> dict:
    token = extract_bearer(authorization)
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT m.member_id, m.display_name, m.can_control_player
            FROM music_member_sessions s
            JOIN club_members m ON m.member_id = s.member_id
            WHERE s.token_hash = %s
              AND s.expires_at > CURRENT_TIMESTAMP
              AND m.active = TRUE;
            """,
            (token_hash(token),),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Anmeldung abgelaufen. Bitte erneut anmelden.")
    return {
        "member_id": row[0], "display_name": row[1],
        "can_control_player": bool(row[2]), "token_hash": token_hash(token),
    }


def require_player_operator(member: dict = Depends(require_member)) -> dict:
    if not member["can_control_player"]:
        raise HTTPException(
            status_code=403,
            detail="Die Verwaltung muss dich zuerst für die Player-Bedienung freigeben.",
        )
    return member


def optional_member(authorization: str | None = Header(default=None)) -> dict | None:
    if not authorization:
        return None
    return require_member(authorization)


def utc_datetime(value: datetime, field_name: str) -> datetime:
    """Require an unambiguous timestamp and normalize it for PostgreSQL."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} muss eine Zeitzone enthalten.",
        )
    return value.astimezone(timezone.utc)


def validate_cycle_window(starts_at: datetime, closes_at: datetime) -> tuple[datetime, datetime]:
    starts_at = utc_datetime(starts_at, "Startzeit")
    closes_at = utc_datetime(closes_at, "Endzeit")
    if closes_at <= starts_at:
        raise HTTPException(status_code=422, detail="Die Endzeit muss nach der Startzeit liegen.")
    if closes_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="Die Endzeit muss in der Zukunft liegen.")
    return starts_at, closes_at


def require_admin(x_admin_password: str | None = Header(default=None)) -> None:
    if not ADMIN_PASSWORD:
        raise HTTPException(status_code=503, detail="Das Verwaltungskennwort ist nicht eingerichtet.")
    if not x_admin_password or not secrets.compare_digest(x_admin_password, ADMIN_PASSWORD):
        raise HTTPException(status_code=401, detail="Verwaltungskennwort ungültig.")


def close_expired_cycles() -> None:
    try:
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE music_cycles SET status = 'closed', updated_at = CURRENT_TIMESTAMP "
                "WHERE status IN ('active', 'planned') AND closes_at <= CURRENT_TIMESTAMP;"
            )
            cur.execute(
                """
                WITH due AS (
                    SELECT id FROM music_cycles
                    WHERE status = 'planned'
                      AND starts_at <= CURRENT_TIMESTAMP
                      AND closes_at > CURRENT_TIMESTAMP
                    ORDER BY starts_at DESC, id DESC
                    LIMIT 1
                )
                UPDATE music_cycles
                SET status = 'closed', updated_at = CURRENT_TIMESTAMP
                WHERE status = 'active'
                  AND EXISTS (SELECT 1 FROM due)
                  AND id <> (SELECT id FROM due);
                """
            )
            cur.execute(
                """
                UPDATE music_cycles
                SET status = 'active', updated_at = CURRENT_TIMESTAMP
                WHERE id = (
                    SELECT id FROM music_cycles
                    WHERE status = 'planned'
                      AND starts_at <= CURRENT_TIMESTAMP
                      AND closes_at > CURRENT_TIMESTAMP
                    ORDER BY starts_at DESC, id DESC
                    LIMIT 1
                );
                """
            )
            cur.execute("DELETE FROM music_member_sessions WHERE expires_at <= CURRENT_TIMESTAMP;")
            conn.commit()
    except Exception as exc:
        print(f"[BACKGROUND ERROR] {exc}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = BackgroundScheduler()
    scheduler.add_job(close_expired_cycles, "interval", minutes=1)
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="ClubIQ Music Voting API", lifespan=lifespan)
app.mount("/pics", StaticFiles(directory="pics"), name="pics")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    )
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


class MemberLogin(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    pin: str = Field(pattern=r"^\d{4,8}$")


class MemberRegister(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    pin: str = Field(pattern=r"^\d{4,8}$")


class MemberAdminCreate(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    pin: str = Field(pattern=r"^\d{4,8}$")


class MemberAdminUpdate(BaseModel):
    pin: str | None = Field(default=None, pattern=r"^\d{4,8}$")
    active: bool | None = None
    can_control_player: bool | None = None


class SuggestionCreate(BaseModel):
    provider: str = Field(default="youtube", pattern=r"^[a-z0-9_-]{2,30}$")
    external_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=255)
    channel_title: str | None = Field(default=None, max_length=255)
    duration_ms: int | None = Field(default=None, ge=0)


class VoteCreate(BaseModel):
    suggestion_id: int
    points: int = Field(ge=0, le=100)


class CycleCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    starts_at: datetime
    closes_at: datetime
    max_budget: int = Field(default=DEFAULT_MAX_BUDGET, ge=1, le=100)
    playlist_target_count: int = Field(default=DEFAULT_PLAYLIST_TARGET, ge=1, le=50)
    reuse_previous_playlist: bool = True
    genre_fallback_enabled: bool = True
    fallback_genre: str = Field(default="Party", max_length=80)


class CycleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    status: str | None = None
    starts_at: datetime | None = None
    closes_at: datetime | None = None
    max_budget: int | None = Field(default=None, ge=1, le=100)
    playlist_target_count: int | None = Field(default=None, ge=1, le=50)
    reuse_previous_playlist: bool | None = None
    genre_fallback_enabled: bool | None = None
    fallback_genre: str | None = Field(default=None, max_length=80)


class PlayerCommand(BaseModel):
    action: str = Field(pattern=r"^(play|pause|next|previous|seek|volume|mute|shuffle|repeat)$")
    value: float | int | bool | str | None = None


class RadioStationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    stream_url: str = Field(min_length=8, max_length=1000)
    fallback_url: str | None = Field(default=None, max_length=1000)
    logo_url: str | None = Field(default=None, max_length=1000)
    genre: str | None = Field(default=None, max_length=80)
    active: bool = True
    sort_order: int = Field(default=0, ge=-1000, le=1000)


class RadioStationImport(BaseModel):
    station_uuid: UUID


class RadioStationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    stream_url: str | None = Field(default=None, min_length=8, max_length=1000)
    fallback_url: str | None = Field(default=None, max_length=1000)
    logo_url: str | None = Field(default=None, max_length=1000)
    genre: str | None = Field(default=None, max_length=80)
    active: bool | None = None
    sort_order: int | None = Field(default=None, ge=-1000, le=1000)


def validate_media_url(value: str | None, label: str, required: bool = False) -> str | None:
    cleaned = value.strip() if value else ""
    if not cleaned:
        if required:
            raise HTTPException(status_code=422, detail=f"{label} fehlt.")
        return None
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=422, detail=f"{label} muss eine vollständige HTTP- oder HTTPS-Adresse sein.")
    return cleaned


class BluetoothDeviceAction(BaseModel):
    address: str = Field(pattern=r"^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$")


class DjQueueItem(BaseModel):
    external_id: str = Field(pattern=r"^[A-Za-z0-9_-]{6,20}$")
    title: str = Field(min_length=1, max_length=255)
    channel_title: str | None = Field(default=None, max_length=255)
    position: str = Field(default="end", pattern=r"^(next|end)$")


class DjQueueMove(BaseModel):
    target_index: int = Field(ge=0, le=249)


@app.get("/")
def read_root():
    return FileResponse("index.html")


@app.get("/remote")
def dj_remote():
    return FileResponse("remote.html")


@app.get("/party")
def party_display():
    return FileResponse("party.html")


@app.get("/manifest.webmanifest")
def pwa_manifest():
    return FileResponse("manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(
        "sw.js", media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/health")
def health():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1;")
        cur.fetchone()
    return {"status": "ok"}


@app.get("/api/v1/music/members")
def list_members():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT display_name FROM club_members WHERE active = TRUE ORDER BY lower(display_name);"
        )
        return {"members": [row[0] for row in cur.fetchall()]}


@app.post("/api/v1/music/auth/login")
def member_login(login: MemberLogin):
    display_name = " ".join(login.display_name.strip().split())
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT member_id, display_name, pin_hash, active, can_control_player
            FROM club_members
            WHERE lower(display_name) = lower(%s)
            ORDER BY id
            LIMIT 1
            FOR UPDATE;
            """,
            (display_name,),
        )
        row = cur.fetchone()
        first_pin = False
        if not row:
            raise HTTPException(
                status_code=404,
                detail="Mitglied nicht gefunden. Bitte von der Verwaltung anlegen lassen.",
            )
        member_id = row[0]
        display_name = row[1]
        if not row[3]:
            raise HTTPException(status_code=403, detail="Dieses Mitglied ist deaktiviert.")
        if not row[2]:
            cur.execute(
                "UPDATE club_members SET pin_hash = %s WHERE member_id = %s;",
                (hash_pin(login.pin), member_id),
            )
            first_pin = True
        elif not verify_pin(login.pin, row[2]):
            raise HTTPException(status_code=401, detail="PIN ist nicht korrekt.")

        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        cur.execute(
            "INSERT INTO music_member_sessions (member_id, token_hash, expires_at) VALUES (%s, %s, %s);",
            (member_id, token_hash(token), expires_at),
        )
        cur.execute(
            """SELECT id, name, max_budget FROM music_cycles
               WHERE status = 'active' AND starts_at <= CURRENT_TIMESTAMP
                 AND closes_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1;"""
        )
        cycle = cur.fetchone()
        used = 0
        if cycle:
            cur.execute(
                "SELECT COALESCE(SUM(points), 0) FROM music_votes WHERE cycle_id = %s AND member_id = %s;",
                (cycle[0], member_id),
            )
            used = int(cur.fetchone()[0])
        conn.commit()

    maximum = int(cycle[2]) if cycle else DEFAULT_MAX_BUDGET
    return {
        "status": "success",
        "token": token,
        "expires_at": expires_at,
        "member": {
            "member_id": member_id, "display_name": display_name,
            "can_control_player": bool(row[4]),
        },
        "budget": {"remaining": max(0, maximum - used), "maximum": maximum},
        "active_cycle_id": cycle[0] if cycle else None,
        "pin_created": first_pin,
    }


@app.post("/api/v1/music/auth/register", status_code=201)
def member_register(registration: MemberRegister):
    display_name = " ".join(registration.display_name.strip().split())
    if len(display_name) < 2:
        raise HTTPException(status_code=422, detail="Bitte einen vollständigen Namen eingeben.")
    member_id = normalize_member_id(display_name)
    if not member_id:
        raise HTTPException(status_code=422, detail="Bitte einen gültigen Namen eingeben.")

    with db_connect() as conn, conn.cursor() as cur:
        # Serialisiert identische Namen, damit auch zwei gleichzeitige Anfragen
        # nicht versehentlich doppelte Konten anlegen können.
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s));", (member_id,))
        cur.execute(
            """
            SELECT 1
            FROM club_members
            WHERE lower(display_name) = lower(%s) OR member_id = %s
            LIMIT 1;
            """,
            (display_name, member_id),
        )
        if cur.fetchone():
            raise HTTPException(
                status_code=409,
                detail="Dieser Name ist bereits registriert. Bitte normal anmelden oder die PIN zurücksetzen lassen.",
            )

        cur.execute(
            """
            INSERT INTO club_members (member_id, display_name, pin_hash, active)
            VALUES (%s, %s, %s, TRUE);
            """,
            (member_id, display_name, hash_pin(registration.pin)),
        )
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        cur.execute(
            "INSERT INTO music_member_sessions (member_id, token_hash, expires_at) VALUES (%s, %s, %s);",
            (member_id, token_hash(token), expires_at),
        )
        cur.execute(
            """SELECT id, max_budget FROM music_cycles
               WHERE status = 'active' AND starts_at <= CURRENT_TIMESTAMP
                 AND closes_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1;"""
        )
        cycle = cur.fetchone()
        conn.commit()

    maximum = int(cycle[1]) if cycle else DEFAULT_MAX_BUDGET
    return {
        "status": "success",
        "token": token,
        "expires_at": expires_at,
        "member": {
            "member_id": member_id, "display_name": display_name,
            "can_control_player": False,
        },
        "budget": {"remaining": maximum, "maximum": maximum},
        "active_cycle_id": cycle[0] if cycle else None,
    }


@app.post("/api/v1/music/auth/logout")
def member_logout(member: dict = Depends(require_member)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM music_member_sessions WHERE token_hash = %s;", (member["token_hash"],))
        conn.commit()
    return {"status": "ok"}


@app.get("/api/v1/music/auth/me")
def member_me(member: dict = Depends(require_member)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, name, max_budget FROM music_cycles
               WHERE status = 'active' AND starts_at <= CURRENT_TIMESTAMP
                 AND closes_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1;"""
        )
        cycle = cur.fetchone()
        used = 0
        if cycle:
            cur.execute(
                "SELECT COALESCE(SUM(points), 0) FROM music_votes WHERE cycle_id = %s AND member_id = %s;",
                (cycle[0], member["member_id"]),
            )
            used = int(cur.fetchone()[0])
    maximum = int(cycle[2]) if cycle else DEFAULT_MAX_BUDGET
    return {
        "member": {
            "member_id": member["member_id"],
            "display_name": member["display_name"],
            "can_control_player": member["can_control_player"],
        },
        "active_cycle_id": cycle[0] if cycle else None,
        "budget": {"remaining": max(0, maximum - used), "maximum": maximum},
    }


def youtube_search(q: str) -> list[dict]:
    if not YOUTUBE_API_KEY:
        raise HTTPException(status_code=503, detail="YouTube-Suche ist noch nicht eingerichtet.")
    try:
        response = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={"part": "snippet", "q": q, "type": "video", "maxResults": 8, "key": YOUTUBE_API_KEY},
            timeout=10,
        )
        response.raise_for_status()
        items = response.json().get("items", [])
        return [
            {
                "external_id": item["id"]["videoId"],
                "title": html.unescape(item["snippet"]["title"]),
                "channel_title": html.unescape(item["snippet"]["channelTitle"]),
                "thumbnail_url": f"/api/v1/music/thumbnails/youtube/{item['id']['videoId']}",
            }
            for item in items
        ]
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Musiksuche ist derzeit nicht erreichbar.") from exc


def youtube_popular_tracks(genre: str, limit: int) -> list[dict]:
    """Load popular music for one genre and cache it to protect the YouTube quota."""
    clean_genre = " ".join(genre.strip().split())[:80]
    if not clean_genre or not YOUTUBE_API_KEY or limit <= 0:
        return []
    cache_key = f"popular:{clean_genre.casefold()}"
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, result_json FROM music_provider_search_cache
            WHERE provider = 'youtube' AND normalized_query = %s AND market = 'DE'
              AND expires_at > CURRENT_TIMESTAMP
            ORDER BY created_at DESC LIMIT 1;
            """,
            (cache_key,),
        )
        cached = cur.fetchone()
        if cached:
            cur.execute(
                "UPDATE music_provider_search_cache SET hit_count = hit_count + 1 WHERE id = %s;",
                (cached[0],),
            )
            conn.commit()
            value = cached[1]
            if isinstance(value, str):
                value = json.loads(value)
            return list(value or [])[:limit]
    try:
        response = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet", "q": f"{clean_genre} Musik", "type": "video",
                "videoCategoryId": "10", "videoEmbeddable": "true", "order": "viewCount",
                "regionCode": "DE", "relevanceLanguage": "de", "safeSearch": "moderate",
                # Always cache a complete candidate set. A later event can have a
                # larger target than the request that initially filled the cache.
                "maxResults": 50, "key": YOUTUBE_API_KEY,
            },
            timeout=10,
        )
        response.raise_for_status()
        results = [
            {
                "external_id": item["id"]["videoId"],
                "title": html.unescape(item["snippet"]["title"]),
                "artist": html.unescape(item["snippet"]["channelTitle"]),
            }
            for item in response.json().get("items", [])
            if YOUTUBE_VIDEO_ID.fullmatch(item.get("id", {}).get("videoId", ""))
        ]
    except (requests.RequestException, KeyError, TypeError, ValueError):
        return []
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM music_provider_search_cache
            WHERE provider = 'youtube' AND normalized_query = %s AND market = 'DE';
            """,
            (cache_key,),
        )
        cur.execute(
            """
            INSERT INTO music_provider_search_cache
                (provider, normalized_query, market, result_json, expires_at)
            VALUES ('youtube', %s, 'DE', %s::jsonb, CURRENT_TIMESTAMP + INTERVAL '12 hours');
            """,
            (cache_key, json.dumps(results)),
        )
        conn.commit()
    return results[:limit]


def merge_playlist_sources(
    current_votes: list[dict], previous_playlist: list[dict], genre_tracks: list[dict], target: int
) -> list[dict]:
    """Merge sources in the defined order and remove duplicate YouTube videos."""
    merged: list[dict] = []
    seen: set[str] = set()
    for source, candidates in (
        ("votes", current_votes), ("previous", previous_playlist), ("genre", genre_tracks)
    ):
        for candidate in candidates:
            external_id = str(candidate.get("external_id") or "")
            if not YOUTUBE_VIDEO_ID.fullmatch(external_id) or external_id in seen:
                continue
            seen.add(external_id)
            merged.append({
                "external_id": external_id,
                "title": str(candidate.get("title") or "Unbekannter Titel")[:255],
                "artist": str(candidate.get("artist") or candidate.get("channel_title") or "")[:255],
                "source": source,
            })
            if len(merged) >= target:
                return merged
    return merged


def player_item(item: dict) -> dict:
    external_id = item["external_id"]
    return {
        "id": f"{item['source']}:{external_id}",
        "title": item["title"],
        "artist": item.get("artist", ""),
        "thumbnail": f"/api/v1/music/thumbnails/youtube/{external_id}",
        "url": f"https://www.youtube.com/watch?v={external_id}",
        "source": item["source"],
    }


@app.get("/api/v1/music/provider/search")
def search_tracks(
    q: str = Query(min_length=3, max_length=100),
    _member: dict = Depends(require_member),
):
    return {"results": youtube_search(q)}


@app.get("/api/v1/music/cycles")
def get_cycles():
    close_expired_cycles()
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, status, starts_at, closes_at, max_budget,
                   playlist_target_count, reuse_previous_playlist,
                   genre_fallback_enabled, fallback_genre
            FROM music_cycles ORDER BY id DESC;
            """
        )
        return {
            "cycles": [
                {
                    "id": row[0], "name": row[1], "status": row[2], "starts_at": row[3],
                    "closes_at": row[4], "max_budget": row[5],
                    "playlist_target_count": row[6], "reuse_previous_playlist": row[7],
                    "genre_fallback_enabled": row[8], "fallback_genre": row[9],
                }
                for row in cur.fetchall()
            ]
        }


@app.get("/api/v1/music/cycles/{cycle_id}/playlist")
def get_playlist(cycle_id: int, member: dict | None = Depends(optional_member)):
    member_id = member["member_id"] if member else ""
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT s.id, s.title, s.channel_title, s.member_id, s.provider, s.external_id,
                   COALESCE(SUM(v.points), 0),
                   COALESCE(MAX(v.points) FILTER (WHERE v.member_id = %s), 0)
            FROM music_suggestions s
            LEFT JOIN music_votes v ON s.id = v.suggestion_id
            WHERE s.cycle_id = %s AND s.status = 'approved'
            GROUP BY s.id
            ORDER BY COALESCE(SUM(v.points), 0) DESC, s.created_at ASC;
            """,
            (member_id, cycle_id),
        )
        rows = cur.fetchall()
    playlist = []
    previous_points = None
    visible_rank = 0
    for position, row in enumerate(rows, start=1):
        total_points = int(row[6])
        if total_points != previous_points:
            visible_rank = position
            previous_points = total_points
        playlist.append({
            "rank": visible_rank, "suggestion_id": row[0], "title": row[1],
            "channel_title": row[2], "suggested_by_me": bool(member) and row[3] == member_id,
            "provider": row[4], "external_id": row[5],
            "thumbnail_url": f"/api/v1/music/thumbnails/youtube/{row[5]}"
            if row[4] == "youtube" and YOUTUBE_VIDEO_ID.fullmatch(row[5] or "") else None,
            "total_points": total_points, "my_points": int(row[7]),
        })
    return {"playlist": playlist}


@app.get("/api/v1/music/player/state")
def get_player_state():
    state = player_agent("GET", "/state")
    if state.get("speaker"):
        state["speaker"].pop("address", None)
    return state


def radio_station_dict(row) -> dict:
    return {
        "id": row[0], "name": row[1], "stream_url": row[2],
        "fallback_url": row[3], "logo_url": row[4], "genre": row[5],
        "active": row[6], "sort_order": row[7], "logo_image_url": station_logo_path(row[0]),
    }


@app.get("/api/v1/music/radio/stations/{station_id}/logo")
def radio_station_logo(station_id: int):
    # No arbitrary URL parameter: only artwork saved by an administrator.
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT logo_url FROM music_radio_stations WHERE id = %s;", (station_id,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Radiosender nicht gefunden.")
    image = cached_logo(row[0])
    if image:
        return Response(content=image[0], media_type=image[1], headers={
            "Cache-Control": f"public, max-age={CACHE_SECONDS}",
        })
    return FileResponse("static/radio-placeholder.svg", media_type="image/svg+xml", headers={
        "Cache-Control": f"public, max-age={FAILURE_SECONDS}",
    })


@app.get("/api/v1/music/player/radio/stations")
def list_radio_stations():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, name, stream_url, fallback_url, logo_url, genre, active, sort_order
               FROM music_radio_stations WHERE active = TRUE
               ORDER BY sort_order, lower(name);"""
        )
        return {"stations": [radio_station_dict(row) for row in cur.fetchall()]}


@app.post("/api/v1/music/player/radio/{station_id}/play")
def play_radio_station(station_id: int, member: dict = Depends(require_player_operator)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, name, stream_url, fallback_url, logo_url, genre, active, sort_order
               FROM music_radio_stations WHERE id = %s AND active = TRUE;""",
            (station_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Radiosender nicht gefunden.")
        station = radio_station_dict(row)
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (%s, 'radio_play', %s);",
            (member["member_id"], json.dumps({"station_id": station_id, "name": station["name"]})),
        )
        conn.commit()
    return player_agent("POST", "/radio", {"station": station})


@app.post("/api/v1/music/player/radio/stop")
def stop_radio(member: dict = Depends(require_player_operator)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (%s, 'radio_stop', '{}');",
            (member["member_id"],),
        )
        conn.commit()
    return player_agent("POST", "/radio/stop", {})


@app.get("/api/v1/music/activity")
def activity_leaderboard(limit: int = Query(default=8, ge=1, le=25)):
    """Return a transparent, spam-resistant leaderboard for the current voting window."""
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            WITH active_cycle AS (
                SELECT id, starts_at, closes_at
                FROM music_cycles
                WHERE status = 'active' AND starts_at <= CURRENT_TIMESTAMP
                  AND closes_at > CURRENT_TIMESTAMP
                ORDER BY id DESC LIMIT 1
            ), vote_activity AS (
                SELECT v.member_id, COUNT(*)::int AS voted_songs,
                       COALESCE(SUM(v.points), 0)::int AS vote_points
                FROM music_votes v JOIN active_cycle c ON c.id = v.cycle_id
                GROUP BY v.member_id
            ), suggestion_activity AS (
                SELECT s.member_id, COUNT(*)::int AS suggestions
                FROM music_suggestions s JOIN active_cycle c ON c.id = s.cycle_id
                WHERE s.status = 'approved'
                GROUP BY s.member_id
            ), player_activity AS (
                SELECT a.member_id, LEAST(COUNT(*), 10)::int AS player_actions
                FROM music_player_audit a CROSS JOIN active_cycle c
                WHERE a.member_id IS NOT NULL
                  AND a.created_at >= c.starts_at AND a.created_at < c.closes_at
                  AND a.action IN ('play', 'next', 'previous', 'queue_from_ranking', 'soundboard')
                GROUP BY a.member_id
            )
            SELECT m.display_name,
                   COALESCE(v.voted_songs, 0), COALESCE(v.vote_points, 0),
                   COALESCE(s.suggestions, 0), COALESCE(p.player_actions, 0),
                   (COALESCE(v.voted_songs, 0) * 2
                    + COALESCE(s.suggestions, 0) * 3
                    + COALESCE(p.player_actions, 0))::int AS activity_score
            FROM club_members m
            LEFT JOIN vote_activity v ON v.member_id = m.member_id
            LEFT JOIN suggestion_activity s ON s.member_id = m.member_id
            LEFT JOIN player_activity p ON p.member_id = m.member_id
            WHERE m.active = TRUE
              AND (v.member_id IS NOT NULL OR s.member_id IS NOT NULL OR p.member_id IS NOT NULL)
            ORDER BY activity_score DESC, v.vote_points DESC NULLS LAST, lower(m.display_name)
            LIMIT %s;
            """,
            (limit,),
        )
        leaders = [
            {
                "rank": index,
                "display_name": row[0],
                "voted_songs": row[1],
                "vote_points": row[2],
                "suggestions": row[3],
                "player_actions": row[4],
                "activity_score": row[5],
            }
            for index, row in enumerate(cur.fetchall(), start=1)
        ]
    return {
        "leaders": leaders,
        "formula": "2 je bewertetem Song + 3 je Vorschlag + 1 je sinnvoller Player-Aktion (maximal 10)",
    }


@app.post("/api/v1/music/player/queue/current")
def use_current_ranking(member: dict = Depends(require_player_operator)):
    return queue_cycle_ranking(None, member)


@app.post("/api/v1/music/player/queue/cycles/{cycle_id}")
def use_cycle_ranking(cycle_id: int, member: dict = Depends(require_player_operator)):
    return queue_cycle_ranking(cycle_id, member)


def queue_cycle_ranking(cycle_id: int | None, member: dict):
    close_expired_cycles()
    with db_connect() as conn, conn.cursor() as cur:
        columns = """SELECT id, starts_at, playlist_target_count, reuse_previous_playlist,
                            genre_fallback_enabled, fallback_genre, status, closes_at, name
                     FROM music_cycles """
        if cycle_id is None:
            cur.execute(columns + """
                WHERE status IN ('active', 'closed') AND starts_at <= CURRENT_TIMESTAMP
                ORDER BY CASE WHEN status = 'active' AND closes_at > CURRENT_TIMESTAMP
                              THEN 0 ELSE 1 END, closes_at DESC, id DESC LIMIT 1;
            """)
        else:
            cur.execute(columns + "WHERE id = %s;", (cycle_id,))
        cycle = cur.fetchone()
        if not cycle:
            raise HTTPException(status_code=404 if cycle_id is not None else 409,
                                detail="Keine verfügbare Abstimmung gefunden.")
        cycle_id, starts_at, target, reuse_previous, use_genre, fallback_genre, status, closes_at, name = cycle
        if status not in {'active', 'closed'} or starts_at > datetime.now(timezone.utc):
            raise HTTPException(status_code=409, detail="Diese Abstimmung hat noch nicht begonnen.")
        archived = status == 'closed' or closes_at <= datetime.now(timezone.utc)
        if archived:
            cur.execute("SELECT items_json FROM music_cycle_playlists WHERE cycle_id = %s AND finalized_at IS NOT NULL;", (cycle_id,))
            saved = cur.fetchone()
            if saved:
                generated = json.loads(saved[0]) if isinstance(saved[0], str) else saved[0]
                return send_ranked_playlist(generated, cycle_id, name, target, use_genre, fallback_genre, member, True)
        cur.execute(
            """
            SELECT s.title, s.channel_title, s.external_id, COALESCE(SUM(v.points), 0) AS points
            FROM music_suggestions s
            JOIN music_votes v ON v.suggestion_id = s.id AND v.cycle_id = s.cycle_id
            WHERE s.cycle_id = %s AND s.status = 'approved' AND s.provider = 'youtube'
            GROUP BY s.id
            HAVING COALESCE(SUM(v.points), 0) > 0
            ORDER BY points DESC, s.created_at ASC;
            """,
            (cycle_id,),
        )
        current_votes = [
            {"title": row[0], "artist": row[1] or "", "external_id": row[2]}
            for row in cur.fetchall()
        ]
        previous_playlist: list[dict] = []
        if reuse_previous and len(current_votes) < target:
            cur.execute(
                """
                SELECT p.items_json
                FROM music_cycle_playlists p
                JOIN music_cycles c ON c.id = p.cycle_id
                WHERE c.id <> %s AND c.starts_at < %s
                ORDER BY c.starts_at DESC, p.generated_at DESC
                LIMIT 1;
                """,
                (cycle_id, starts_at),
            )
            previous = cur.fetchone()
            if previous:
                previous_playlist = previous[0]
                if isinstance(previous_playlist, str):
                    previous_playlist = json.loads(previous_playlist)
            else:
                cur.execute(
                    """
                    WITH previous_cycle AS (
                        SELECT id FROM music_cycles
                        WHERE id <> %s AND starts_at < %s
                        ORDER BY starts_at DESC LIMIT 1
                    )
                    SELECT s.title, s.channel_title, s.external_id
                    FROM music_suggestions s
                    JOIN music_votes v ON v.suggestion_id = s.id AND v.cycle_id = s.cycle_id
                    JOIN previous_cycle c ON c.id = s.cycle_id
                    WHERE s.status = 'approved' AND s.provider = 'youtube'
                    GROUP BY s.id
                    HAVING COALESCE(SUM(v.points), 0) > 0
                    ORDER BY COALESCE(SUM(v.points), 0) DESC, s.created_at ASC
                    LIMIT %s;
                    """,
                    (cycle_id, starts_at, target),
                )
                previous_playlist = [
                    {"title": row[0], "artist": row[1] or "", "external_id": row[2]}
                    for row in cur.fetchall()
                ]

    prior = merge_playlist_sources(current_votes, previous_playlist, [], int(target))
    remaining = max(0, int(target) - len(prior))
    genre_tracks = youtube_popular_tracks(fallback_genre, remaining) if use_genre else []
    generated = merge_playlist_sources(current_votes, previous_playlist, genre_tracks, int(target))
    items = [player_item(item) for item in generated]
    if not items:
        raise HTTPException(
            status_code=409,
            detail="Es gibt noch keine Stimmen und keine verfügbaren Titel zum Auffüllen.",
        )
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO music_cycle_playlists (cycle_id, items_json, generated_at, updated_at, finalized_at)
            VALUES (%s, %s::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                    CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE NULL END)
            ON CONFLICT (cycle_id) DO UPDATE
            SET items_json = EXCLUDED.items_json, generated_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP, finalized_at = EXCLUDED.finalized_at
            WHERE music_cycle_playlists.finalized_at IS NULL;
            """,
            (cycle_id, json.dumps(generated), archived),
        )
        # Another DJ may have finalized this cycle while provider results loaded.
        # Always use the winning snapshot, never overwrite an existing final list.
        cur.execute("SELECT items_json FROM music_cycle_playlists WHERE cycle_id = %s;", (cycle_id,))
        stored = cur.fetchone()[0]
        generated = json.loads(stored) if isinstance(stored, str) else stored
        conn.commit()
    return send_ranked_playlist(generated, cycle_id, name, target, use_genre, fallback_genre, member, archived)


def send_ranked_playlist(generated, cycle_id, name, target, use_genre, fallback_genre, member, archived):
    items = [player_item(item) for item in generated]
    counts = {source: sum(1 for item in generated if item.get('source') == source)
              for source in ('votes', 'previous', 'genre')}
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (%s, 'queue_from_ranking', %s);",
            (member["member_id"], json.dumps({
                "cycle_id": cycle_id, "songs": len(items), "target": target,
                "genre": fallback_genre if use_genre else None, "sources": counts,
            })),
        )
        conn.commit()
    result = player_agent("POST", "/queue", {"items": items})
    result["playlist_build"] = {
        "target": target, "total": len(items), "sources": counts,
        "genre": fallback_genre if use_genre else None,
        "cycle_id": cycle_id, "cycle_name": name, "archived": archived,
    }
    return result


@app.post("/api/v1/music/player/command")
def control_player(command: PlayerCommand, member: dict = Depends(require_player_operator)):
    allowed_values = {
        "seek": lambda value: isinstance(value, (int, float)) and 0 <= float(value) <= 86400,
        "volume": lambda value: isinstance(value, (int, float)) and 0 <= float(value) <= 100,
        "mute": lambda value: isinstance(value, bool),
        "shuffle": lambda value: isinstance(value, bool),
        "repeat": lambda value: value in {"off", "one", "all"},
    }
    if command.action in allowed_values and not allowed_values[command.action](command.value):
        raise HTTPException(status_code=422, detail="Ungültiger Wert für den Player-Befehl.")
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (%s, %s, %s);",
            (member["member_id"], command.action, json.dumps({"value": command.value})),
        )
        conn.commit()
    return player_agent("POST", "/command", command.model_dump())


@app.post("/api/v1/music/admin/player/command", dependencies=[Depends(require_admin)])
def admin_control_player(command: PlayerCommand):
    allowed_values = {
        "seek": lambda value: isinstance(value, (int, float)) and 0 <= float(value) <= 86400,
        "volume": lambda value: isinstance(value, (int, float)) and 0 <= float(value) <= 100,
        "mute": lambda value: isinstance(value, bool),
        "shuffle": lambda value: isinstance(value, bool),
        "repeat": lambda value: value in {"off", "one", "all"},
    }
    if command.action in allowed_values and not allowed_values[command.action](command.value):
        raise HTTPException(status_code=422, detail="Ungültiger Wert für den Player-Befehl.")
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (NULL, %s, %s);",
            (f"dj_{command.action}", json.dumps({"value": command.value})),
        )
        conn.commit()
    return player_agent("POST", "/command", command.model_dump())


@app.get("/api/v1/music/admin/player/search", dependencies=[Depends(require_admin)])
def dj_search(q: str = Query(min_length=3, max_length=100)):
    return {"results": youtube_search(q)}


@app.get("/api/v1/music/admin/backup/status", dependencies=[Depends(require_admin)])
def backup_status():
    try:
        status = json.loads(BACKUP_STATUS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        status = {"ok": False, "message": "Noch keine automatische Sicherung vorhanden."}
    return status


@app.post("/api/v1/music/admin/player/queue", dependencies=[Depends(require_admin)])
def dj_add_to_queue(item: DjQueueItem):
    if not YOUTUBE_VIDEO_ID.fullmatch(item.external_id):
        raise HTTPException(status_code=422, detail="Ungültige YouTube-Kennung.")
    payload = {
        "item": {
            "id": f"dj:{item.external_id}",
            "title": item.title.strip(),
            "artist": (item.channel_title or "").strip(),
            "thumbnail": f"/api/v1/music/thumbnails/youtube/{item.external_id}",
            "url": f"https://www.youtube.com/watch?v={item.external_id}",
            "source": "dj",
        },
        "position": item.position,
    }
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (NULL, 'dj_queue_add', %s);",
            (json.dumps({"external_id": item.external_id, "position": item.position}),),
        )
        conn.commit()
    return player_agent("POST", "/queue/add", payload)


@app.patch("/api/v1/music/admin/player/queue/{source_index}", dependencies=[Depends(require_admin)])
def dj_move_queue_item(source_index: int, move: DjQueueMove):
    return player_agent(
        "POST", "/queue/move", {"source_index": source_index, "target_index": move.target_index}
    )


@app.post("/api/v1/music/admin/player/queue/{index}/play", dependencies=[Depends(require_admin)])
def dj_play_queue_item(index: int):
    return player_agent("POST", "/queue/play", {"index": index})


@app.delete("/api/v1/music/admin/player/queue/{index}", dependencies=[Depends(require_admin)])
def dj_remove_queue_item(index: int):
    return player_agent("POST", "/queue/remove", {"index": index})


@app.get("/api/v1/music/player/bluetooth/devices", dependencies=[Depends(require_admin)])
def bluetooth_devices():
    return player_agent("GET", "/bluetooth/devices")


@app.post("/api/v1/music/player/bluetooth/scan", dependencies=[Depends(require_admin)])
def bluetooth_scan():
    return player_agent("POST", "/bluetooth/scan", {}, timeout=20)


@app.post("/api/v1/music/player/bluetooth/{operation}", dependencies=[Depends(require_admin)])
def bluetooth_action(operation: str, device: BluetoothDeviceAction):
    if operation not in {"connect", "disconnect", "forget"}:
        raise HTTPException(status_code=404, detail="Bluetooth-Aktion nicht gefunden.")
    # Pairing, trust, connection and status are awaited sequentially by BlueZ.
    return player_agent("POST", f"/bluetooth/{operation}", device.model_dump(), timeout=90)


@app.get("/api/v1/music/player/soundboard")
def list_soundboard():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, color, category, duration_ms, builtin_key FROM music_soundboard_items WHERE active = TRUE ORDER BY lower(name);"
        )
        return {"items": [{"id": row[0], "name": row[1], "color": row[2], "category": row[3],
                           "duration_ms": row[4], "builtin": row[5] is not None} for row in cur.fetchall()]}


@app.get("/api/v1/music/player/soundboard/{item_id}/audio")
def soundboard_audio(item_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT media_type, audio_data FROM music_soundboard_items WHERE id = %s AND active = TRUE;",
            (item_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Sound nicht gefunden.")
    return Response(content=bytes(row[1]), media_type=row[0], headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/v1/music/player/soundboard/{item_id}/play")
def play_soundboard(item_id: int, member: dict = Depends(require_player_operator)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM music_soundboard_items WHERE id = %s AND active = TRUE;", (item_id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Sound nicht gefunden.")
        cur.execute(
            "INSERT INTO music_player_audit (member_id, action, detail_json) VALUES (%s, 'soundboard', %s);",
            (member["member_id"], json.dumps({"sound_id": item_id})),
        )
        conn.commit()
    url = f"{PLAYER_PUBLIC_BASE_URL}/api/v1/music/player/soundboard/{item_id}/audio"
    return player_agent("POST", "/command", {"action": "sound", "value": url})


@app.post("/api/v1/music/admin/soundboard", dependencies=[Depends(require_admin)], status_code=201)
async def upload_soundboard(
    name: str = Form(min_length=1, max_length=80),
    color: str = Form(default="green", pattern=r"^(green|gold|red|blue)$"),
    audio: UploadFile = File(...),
    category: str = Form(default="Eigene", pattern=r"^(Darts|Jubel|Spaß|Eigene)$"),
):
    media_type = (audio.content_type or "").lower()
    if media_type not in SOUNDBOARD_MEDIA_TYPES:
        raise HTTPException(status_code=415, detail="Bitte MP3, WAV, OGG, M4A oder WebM verwenden.")
    content = await audio.read(MAX_SOUNDBOARD_BYTES + 1)
    if not content or len(content) > MAX_SOUNDBOARD_BYTES:
        raise HTTPException(status_code=413, detail="Der Sound darf höchstens 3 MB groß sein.")
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO music_soundboard_items (name, media_type, audio_data, color, category) VALUES (%s, %s, %s, %s, %s) RETURNING id;",
            (name.strip(), media_type, content, color, category),
        )
        item_id = cur.fetchone()[0]
        conn.commit()
    return {"status": "success", "id": item_id}


@app.delete("/api/v1/music/admin/soundboard/{item_id}", dependencies=[Depends(require_admin)])
def delete_soundboard(item_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("UPDATE music_soundboard_items SET active = FALSE WHERE id = %s AND active = TRUE;", (item_id,))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Sound nicht gefunden.")
        conn.commit()
    return {"status": "success"}


@app.get("/api/v1/music/thumbnails/youtube/{video_id}")
def youtube_thumbnail(video_id: str):
    if not YOUTUBE_VIDEO_ID.fullmatch(video_id):
        raise HTTPException(status_code=404, detail="Vorschaubild nicht gefunden.")
    try:
        image = requests.get(f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg", timeout=6)
        image.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=404, detail="Vorschaubild nicht erreichbar.") from exc
    return Response(
        content=image.content,
        media_type=image.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400, stale-if-error=604800"},
    )


@app.post("/api/v1/music/cycles/{cycle_id}/suggestions")
def create_suggestion(cycle_id: int, suggestion: SuggestionCreate, member: dict = Depends(require_member)):
    title = suggestion.title.strip()
    external_id = suggestion.external_id.strip()
    if not title or not external_id:
        raise HTTPException(status_code=400, detail="Songangaben fehlen.")
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO music_suggestions
                (cycle_id, member_id, provider, external_id, title, channel_title, duration_ms)
            SELECT id, %s, %s, %s, %s, %s, %s
            FROM music_cycles
            WHERE id = %s AND status = 'active'
              AND starts_at <= CURRENT_TIMESTAMP AND closes_at > CURRENT_TIMESTAMP
              AND NOT EXISTS (
                  SELECT 1 FROM music_suggestions
                  WHERE cycle_id = %s AND provider = %s AND external_id = %s
              )
            RETURNING id;
            """,
            (
                member["member_id"], suggestion.provider, external_id, title,
                suggestion.channel_title, suggestion.duration_ms, cycle_id,
                cycle_id, suggestion.provider, external_id,
            ),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="Song bereits vorhanden oder Abstimmung geschlossen.")
        conn.commit()
    return {"status": "success", "suggestion_id": row[0]}


@app.post("/api/v1/music/cycles/{cycle_id}/votes")
def cast_vote(cycle_id: int, vote: VoteCreate, member: dict = Depends(require_member)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s));", (f"{cycle_id}:{member['member_id']}",))
        cur.execute(
            """
            SELECT c.max_budget
            FROM music_suggestions s
            JOIN music_cycles c ON c.id = s.cycle_id
            WHERE s.id = %s AND s.cycle_id = %s AND c.status = 'active'
              AND c.starts_at <= CURRENT_TIMESTAMP AND c.closes_at > CURRENT_TIMESTAMP
              AND s.status = 'approved';
            """,
            (vote.suggestion_id, cycle_id),
        )
        cycle = cur.fetchone()
        if not cycle:
            raise HTTPException(status_code=409, detail="Song oder Abstimmung ist nicht aktiv.")
        maximum = int(cycle[0])
        cur.execute(
            "SELECT COALESCE(SUM(points), 0) FROM music_votes "
            "WHERE cycle_id = %s AND member_id = %s AND suggestion_id <> %s;",
            (cycle_id, member["member_id"], vote.suggestion_id),
        )
        other_points = int(cur.fetchone()[0])
        if other_points + vote.points > maximum:
            raise HTTPException(status_code=400, detail="Dein Punktebudget reicht dafür nicht aus.")
        if vote.points == 0:
            cur.execute(
                "DELETE FROM music_votes WHERE cycle_id = %s AND suggestion_id = %s AND member_id = %s;",
                (cycle_id, vote.suggestion_id, member["member_id"]),
            )
        else:
            cur.execute(
                """
                INSERT INTO music_votes (cycle_id, suggestion_id, member_id, points)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (cycle_id, suggestion_id, member_id)
                DO UPDATE SET points = EXCLUDED.points, created_at = CURRENT_TIMESTAMP;
                """,
                (cycle_id, vote.suggestion_id, member["member_id"], vote.points),
            )
        conn.commit()
    return {"status": "success", "my_points": vote.points, "budget_remaining": maximum - other_points - vote.points}


@app.get("/api/v1/music/admin/verify", dependencies=[Depends(require_admin)])
def verify_admin():
    return {"status": "ok"}


@app.get("/api/v1/music/admin/overview", dependencies=[Depends(require_admin)])
def admin_overview():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM club_members WHERE active = TRUE;")
        members = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM music_suggestions;")
        songs = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM music_votes;")
        votes = cur.fetchone()[0]
    return {"members": members, "songs": songs, "votes": votes}


@app.get("/api/v1/music/admin/members", dependencies=[Depends(require_admin)])
def admin_members():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT member_id, display_name, active, pin_hash IS NOT NULL, created_at,
                   can_control_player
            FROM club_members
            ORDER BY active DESC, lower(display_name);
            """
        )
        return {
            "members": [
                {
                    "member_id": row[0],
                    "display_name": row[1],
                    "active": row[2],
                    "pin_ready": row[3],
                    "created_at": row[4],
                    "can_control_player": bool(row[5]),
                }
                for row in cur.fetchall()
            ]
        }


@app.post("/api/v1/music/admin/members", dependencies=[Depends(require_admin)])
def create_member(member: MemberAdminCreate):
    display_name = " ".join(member.display_name.strip().split())
    member_id = normalize_member_id(display_name)
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO club_members (member_id, display_name, pin_hash, active)
            SELECT %s, %s, %s, TRUE
            WHERE NOT EXISTS (
                SELECT 1 FROM club_members WHERE lower(display_name) = lower(%s)
            )
            ON CONFLICT (member_id) DO NOTHING
            RETURNING member_id;
            """,
            (member_id, display_name, hash_pin(member.pin), display_name),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="Dieses Mitglied ist bereits vorhanden.")
        conn.commit()
    return {"status": "success", "member_id": row[0]}


@app.patch("/api/v1/music/admin/members/{member_id}", dependencies=[Depends(require_admin)])
def update_member(member_id: str, update: MemberAdminUpdate):
    pin_hash = hash_pin(update.pin) if update.pin is not None else None
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE club_members
            SET pin_hash = COALESCE(%s, pin_hash),
                active = COALESCE(%s, active),
                can_control_player = COALESCE(%s, can_control_player)
            WHERE member_id = %s;
            """,
            (pin_hash, update.active, update.can_control_player, member_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Mitglied nicht gefunden.")
        if update.pin is not None or update.active is False:
            cur.execute("DELETE FROM music_member_sessions WHERE member_id = %s;", (member_id,))
        conn.commit()
    return {"status": "success"}


@app.get("/api/v1/music/admin/radio/stations", dependencies=[Depends(require_admin)])
def admin_radio_stations():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, name, stream_url, fallback_url, logo_url, genre, active, sort_order
               FROM music_radio_stations ORDER BY sort_order, lower(name);"""
        )
        return {"stations": [radio_station_dict(row) for row in cur.fetchall()]}


@app.get("/api/v1/music/admin/radio/search", dependencies=[Depends(require_admin)])
def search_radio_directory(q: str = Query(min_length=2, max_length=80)):
    try:
        return {"stations": search_stations(q), "source": "Radio-Browser"}
    except DirectoryUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/v1/music/admin/radio/import", dependencies=[Depends(require_admin)])
def import_radio_station(selection: RadioStationImport):
    try:
        station = get_station(selection.station_uuid)
    except DirectoryUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    with db_connect() as conn, conn.cursor() as cur:
        # Serialize imports so a retry/double click cannot create duplicates.
        cur.execute("SELECT pg_advisory_xact_lock(724031);")
        cur.execute("SELECT id FROM music_radio_stations WHERE stream_url = %s LIMIT 1;",
                    (station["stream_url"],))
        existing = cur.fetchone()
        if existing:
            return {"status": "existing", "id": existing[0]}
        cur.execute(
            """INSERT INTO music_radio_stations (name, stream_url, logo_url, genre)
               VALUES (%s, %s, %s, %s) RETURNING id;""",
            (station["name"], station["stream_url"], station["logo_url"], station["genre"]),
        )
        station_id = cur.fetchone()[0]
        conn.commit()
    return {"status": "success", "id": station_id}


@app.post("/api/v1/music/admin/radio/stations", dependencies=[Depends(require_admin)], status_code=201)
def create_radio_station(station: RadioStationCreate):
    stream_url = validate_media_url(station.stream_url, "Stream-Adresse", True)
    fallback_url = validate_media_url(station.fallback_url, "Ersatz-Stream")
    logo_url = validate_media_url(station.logo_url, "Logo-Adresse")
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO music_radio_stations
               (name, stream_url, fallback_url, logo_url, genre, active, sort_order)
               VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id;""",
            (station.name.strip(), stream_url, fallback_url, logo_url,
             station.genre.strip() if station.genre else None, station.active, station.sort_order),
        )
        station_id = cur.fetchone()[0]
        conn.commit()
    return {"status": "success", "id": station_id}


@app.patch("/api/v1/music/admin/radio/stations/{station_id}", dependencies=[Depends(require_admin)])
def update_radio_station(station_id: int, update: RadioStationUpdate):
    fields = update.model_dump(exclude_unset=True)
    if not fields:
        return {"status": "success"}
    if "stream_url" in fields:
        fields["stream_url"] = validate_media_url(fields["stream_url"], "Stream-Adresse", True)
    for field, label in (("fallback_url", "Ersatz-Stream"), ("logo_url", "Logo-Adresse")):
        if field in fields:
            fields[field] = validate_media_url(fields[field], label)
    allowed = {"name", "stream_url", "fallback_url", "logo_url", "genre", "active", "sort_order"}
    assignments = [f"{field} = %s" for field in fields if field in allowed]
    values = [fields[field] for field in fields if field in allowed]
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE music_radio_stations SET {', '.join(assignments)}, updated_at = CURRENT_TIMESTAMP WHERE id = %s;",
            (*values, station_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Radiosender nicht gefunden.")
        conn.commit()
    return {"status": "success"}


@app.delete("/api/v1/music/admin/radio/stations/{station_id}", dependencies=[Depends(require_admin)])
def delete_radio_station(station_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM music_radio_stations WHERE id = %s;", (station_id,))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Radiosender nicht gefunden.")
        conn.commit()
    return {"status": "success"}


@app.post("/api/v1/music/admin/radio/stations/{station_id}/play", dependencies=[Depends(require_admin)])
def admin_play_radio_station(station_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, name, stream_url, fallback_url, logo_url, genre, active, sort_order
               FROM music_radio_stations WHERE id = %s AND active = TRUE;""",
            (station_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Radiosender nicht gefunden.")
    return player_agent("POST", "/radio", {"station": radio_station_dict(row)})


@app.post("/api/v1/music/admin/radio/stop", dependencies=[Depends(require_admin)])
def admin_stop_radio():
    return player_agent("POST", "/radio/stop", {})


@app.post("/api/v1/music/admin/cycles", dependencies=[Depends(require_admin)])
def create_cycle(cycle: CycleCreate):
    starts_at, closes_at = validate_cycle_window(cycle.starts_at, cycle.closes_at)
    fallback_genre = " ".join(cycle.fallback_genre.strip().split())
    if cycle.genre_fallback_enabled and not fallback_genre:
        raise HTTPException(status_code=422, detail="Bitte ein Genre für die Playlist-Auffüllung angeben.")
    status = "active" if starts_at <= datetime.now(timezone.utc) else "planned"
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM music_cycles
            WHERE status IN ('planned', 'active')
              AND starts_at < %s AND closes_at > %s
            LIMIT 1;
            """,
            (closes_at, starts_at),
        )
        if cur.fetchone():
            raise HTTPException(
                status_code=409,
                detail="In diesem Zeitraum ist bereits eine Abstimmung geplant.",
            )
        cur.execute(
            """
            INSERT INTO music_cycles
                (name, type, profile_id, starts_at, closes_at, status, max_budget,
                 playlist_target_count, reuse_previous_playlist,
                 genre_fallback_enabled, fallback_genre)
            VALUES (%s, 'custom', 1, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id;
            """,
            (
                cycle.name.strip(), starts_at, closes_at, status, cycle.max_budget,
                cycle.playlist_target_count, cycle.reuse_previous_playlist,
                cycle.genre_fallback_enabled, fallback_genre,
            ),
        )
        cycle_id = cur.fetchone()[0]
        conn.commit()
    return {"status": "success", "cycle_id": cycle_id}


@app.patch("/api/v1/music/admin/cycles/{cycle_id}", dependencies=[Depends(require_admin)])
def update_cycle(cycle_id: int, update: CycleUpdate):
    if update.status not in {None, "planned", "active", "closed"}:
        raise HTTPException(status_code=400, detail="Ungültiger Status.")
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT starts_at, closes_at, status, fallback_genre, genre_fallback_enabled
            FROM music_cycles WHERE id = %s;
            """,
            (cycle_id,),
        )
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Abstimmung nicht gefunden.")
        starts_at = utc_datetime(update.starts_at, "Startzeit") if update.starts_at else existing[0]
        closes_at = utc_datetime(update.closes_at, "Endzeit") if update.closes_at else existing[1]
        if update.status == "active":
            starts_at = datetime.now(timezone.utc)
        if closes_at <= starts_at:
            raise HTTPException(status_code=422, detail="Die Endzeit muss nach der Startzeit liegen.")
        target_status = update.status or existing[2]
        fallback_genre = (
            " ".join(update.fallback_genre.strip().split())
            if update.fallback_genre is not None else existing[3]
        )
        genre_enabled = (
            update.genre_fallback_enabled
            if update.genre_fallback_enabled is not None else existing[4]
        )
        if genre_enabled and not fallback_genre:
            raise HTTPException(status_code=422, detail="Bitte ein Genre für die Playlist-Auffüllung angeben.")
        if target_status in {"planned", "active"}:
            cur.execute(
                """
                SELECT id FROM music_cycles
                WHERE id <> %s
                  AND status IN ('planned', 'active')
                  AND starts_at < %s AND closes_at > %s
                LIMIT 1;
                """,
                (cycle_id, closes_at, starts_at),
            )
            if cur.fetchone():
                raise HTTPException(
                    status_code=409,
                    detail="In diesem Zeitraum ist bereits eine Abstimmung geplant.",
                )
        if update.status == "active":
            cur.execute("UPDATE music_cycles SET status = 'closed' WHERE status = 'active' AND id <> %s;", (cycle_id,))
        cur.execute(
            """
            UPDATE music_cycles
            SET name = COALESCE(%s, name), status = COALESCE(%s, status),
                starts_at = %s, closes_at = %s, max_budget = COALESCE(%s, max_budget),
                playlist_target_count = COALESCE(%s, playlist_target_count),
                reuse_previous_playlist = COALESCE(%s, reuse_previous_playlist),
                genre_fallback_enabled = COALESCE(%s, genre_fallback_enabled),
                fallback_genre = %s,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s;
            """,
            (
                update.name, update.status, starts_at, closes_at, update.max_budget,
                update.playlist_target_count, update.reuse_previous_playlist,
                update.genre_fallback_enabled, fallback_genre, cycle_id,
            ),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Abstimmung nicht gefunden.")
        if target_status in {"planned", "active"} and closes_at > datetime.now(timezone.utc):
            # Explicitly reopening a cycle allows new votes to determine its next final list.
            cur.execute("UPDATE music_cycle_playlists SET finalized_at = NULL WHERE cycle_id = %s;", (cycle_id,))
        conn.commit()
    return {"status": "success"}


@app.get("/api/v1/music/cycles/{cycle_id}/suggestions", dependencies=[Depends(require_admin)])
def get_suggestions(cycle_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT s.id, s.title, s.channel_title, s.member_id, COALESCE(SUM(v.points), 0)
            FROM music_suggestions s LEFT JOIN music_votes v ON v.suggestion_id = s.id
            WHERE s.cycle_id = %s GROUP BY s.id ORDER BY s.created_at DESC;
            """,
            (cycle_id,),
        )
        return {"suggestions": [
            {"suggestion_id": r[0], "title": r[1], "channel_title": r[2], "member_id": r[3], "total_points": int(r[4])}
            for r in cur.fetchall()
        ]}


@app.post("/api/v1/music/admin/cycles/{cycle_id}/suggestions", dependencies=[Depends(require_admin)])
def create_moderator_suggestion(cycle_id: int, suggestion: SuggestionCreate):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO music_suggestions (cycle_id, member_id, provider, external_id, title, channel_title, duration_ms)
            SELECT id, 'moderation', %s, %s, %s, %s, %s FROM music_cycles
            WHERE id = %s AND status = 'active'
              AND starts_at <= CURRENT_TIMESTAMP AND closes_at > CURRENT_TIMESTAMP
            RETURNING id;
            """,
            (suggestion.provider, suggestion.external_id, suggestion.title, suggestion.channel_title, suggestion.duration_ms, cycle_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="Abstimmung ist nicht aktiv.")
        conn.commit()
    return {"status": "success", "suggestion_id": row[0]}


@app.delete("/api/v1/music/admin/suggestions/{suggestion_id}", dependencies=[Depends(require_admin)])
def delete_suggestion(suggestion_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM music_suggestions WHERE id = %s;", (suggestion_id,))
        conn.commit()
    return {"status": "success"}


@app.get("/api/v1/music/admin/all-votes", dependencies=[Depends(require_admin)])
def get_all_votes():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT COALESCE(m.display_name, v.member_id), s.title, v.points, v.created_at
            FROM music_votes v JOIN music_suggestions s ON s.id = v.suggestion_id
            LEFT JOIN club_members m ON m.member_id = v.member_id
            ORDER BY v.created_at DESC LIMIT 500;
            """
        )
        return {"votes": [
            {"member": r[0], "title": r[1], "points": r[2], "created_at": r[3]}
            for r in cur.fetchall()
        ]}
