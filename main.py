from __future__ import annotations

import hashlib
import http.client
import html
import asyncio
import json
import os
import queue
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
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db_config import connection_kwargs
from darts_feed import DartsFeedUnavailable, get_darts_center, get_darts_feed, get_darts_match, get_darts_player_stats, get_darts_season
from darts_live import darts_live_hub
from darts_push import barver_push_candidates, push_payload, valid_push_endpoint, valid_push_key, subscription_matches, PUSH_EVENT_TYPES
from radio_directory import DirectoryUnavailable, get_station, search_stations
from radio_logos import CACHE_SECONDS, FAILURE_SECONDS, cached_logo
from music_library import duration_ms, register_library

load_dotenv()

DEFAULT_MAX_BUDGET = int(os.getenv("MAX_BUDGET", "10"))
DEFAULT_PLAYLIST_TARGET = max(1, min(100, int(os.getenv("PLAYLIST_TARGET_COUNT", "20"))))
PREVIOUS_PLAYLIST_LIMIT = 5
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
DARTS_VAPID_PUBLIC_KEY = os.getenv("DARTS_VAPID_PUBLIC_KEY", "").strip()
DARTS_VAPID_PRIVATE_KEY = os.getenv("DARTS_VAPID_PRIVATE_KEY", "").strip()
DARTS_VAPID_SUBJECT = os.getenv("DARTS_VAPID_SUBJECT", "https://barverdarts.clubiq.party").strip()

try:
    from pywebpush import WebPushException, webpush
except ImportError:  # Local development without optional push dependency.
    WebPushException = Exception
    webpush = None


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


_darts_push_status = {
    "configured": bool(DARTS_VAPID_PUBLIC_KEY and DARTS_VAPID_PRIVATE_KEY and webpush),
    "upstreamAvailable": None,
    "lastCheck": None,
    "lastSuccess": None,
    "lastError": None,
    "detected": 0,
    "sent": 0,
    "failed": 0,
}


def _store_and_deliver_darts_events(detected: list[dict], stale: bool = False) -> None:
    """Use the existing durable deduplication and subscriptions for every source."""
    checked_at = datetime.now(timezone.utc).isoformat()
    _darts_push_status["lastCheck"] = checked_at
    configured = bool(DARTS_VAPID_PUBLIC_KEY and DARTS_VAPID_PRIVATE_KEY and webpush)
    new_events = []
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT EXISTS (SELECT 1 FROM darts_push_events LIMIT 1);")
        has_event_history = bool(cur.fetchone()[0])
        for event in detected:
            cur.execute(
                """
                INSERT INTO darts_push_events (event_id, event_type, team, player, match_id, payload, occurred_at)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT (event_id) DO UPDATE SET
                  payload = EXCLUDED.payload,
                  occurred_at = COALESCE(darts_push_events.occurred_at, EXCLUDED.occurred_at)
                RETURNING (xmax = 0);
                """,
                (event["event_id"], event["event_type"], event["team"], event["player"], event["match_id"], push_payload(event), event.get("occurred_at")),
            )
            if cur.fetchone()[0] and has_event_history and event.get("deliver"):
                new_events.append(event)
        cur.execute("SELECT endpoint, p256dh, auth, teams, players, event_types FROM darts_push_subscriptions WHERE enabled = TRUE;")
        subscriptions = cur.fetchall()
        conn.commit()
    expired, sent, failed = [], 0, 0
    for event in new_events:
        for endpoint, p256dh, auth, teams, players, event_types in subscriptions:
            if not configured or not subscription_matches(event, teams or [], players or [], event_types or []):
                continue
            try:
                webpush(
                    subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                    data=push_payload(event), vapid_private_key=DARTS_VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": DARTS_VAPID_SUBJECT}, ttl=300,
                )
                sent += 1
            except WebPushException as exc:
                failed += 1
                if getattr(getattr(exc, "response", None), "status_code", None) in (404, 410):
                    expired.append(endpoint)
                else:
                    print("[DARTS PUSH] Eine Browser-Meldung konnte nicht zugestellt werden.")
    if expired:
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM darts_push_subscriptions WHERE endpoint = ANY(%s);", (list(set(expired)),))
            conn.commit()
    _darts_push_status.update({
        "configured": configured, "upstreamAvailable": not stale,
        "lastSuccess": _darts_push_status["lastSuccess"] if stale else checked_at,
        "lastError": "3K liefert zwischengespeicherte Daten." if stale else None,
        "detected": len(detected), "sent": sent, "failed": failed,
    })


def poll_darts_push_events() -> None:
    checked_at = datetime.now(timezone.utc).isoformat()
    _darts_push_status["lastCheck"] = checked_at
    try:
        detected, stale = [], False
        for league in ("kl04", "kk11"):
            try:
                center = get_darts_center(league)
            except DartsFeedUnavailable:
                stale = True
                continue
            stale = stale or bool(center.get("stale"))
            if center.get("stale"):
                continue
            match_times = {m["id"]: m.get("updatedAt") or m.get("plannedAt") for m in center.get("barverMatches", [])}
            detected.extend({**e, "occurred_at": match_times.get(e["match_id"]), "deliver": e["deliver"]} for e in barver_push_candidates(league, center))
        _store_and_deliver_darts_events(detected, stale)
    except (DartsFeedUnavailable, ValueError, psycopg.Error) as exc:
        cause = type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__
        _darts_push_status.update({"upstreamAvailable": False, "lastError": cause, "detected": 0, "sent": 0})
        print(f"[DARTS PUSH] {type(exc).__name__} ({cause}): Push-Prüfung wird später wiederholt.")


def sync_darts_live_groups() -> None:
    try:
        feed = get_darts_feed()
        if not feed.get("stale"):
            darts_live_hub.reconcile(feed.get("items") or [])
    except (DartsFeedUnavailable, ValueError, requests.RequestException) as exc:
        print(f"[DARTS LIVE] {type(exc).__name__}: Begegnungen werden später erneut geprüft.")


def deliver_darts_live_events() -> None:
    raw_events = darts_live_hub.drain_events()
    detected = []
    for raw in raw_events:
        event = barver_push_event("live", raw)
        if event:
            detected.append({**event, "occurred_at": raw.get("occurred_at"), "deliver": True})
    if not detected:
        return
    try:
        _store_and_deliver_darts_events(detected)
    except psycopg.Error as exc:
        darts_live_hub.requeue_events(raw_events)
        print(f"[DARTS LIVE PUSH] {type(exc).__name__}: Ereignisse werden durch den REST-Abgleich nachgeholt.")


def warm_darts_season() -> None:
    """Keep the expensive 3K season overview ready before a visitor opens it."""
    try:
        get_darts_season()
    except (DartsFeedUnavailable, ValueError, requests.RequestException) as exc:
        print(f"[DARTS CACHE] {type(exc).__name__}: Saisonübersicht wird später erneut vorgeladen.")


def warm_darts_player_stats() -> None:
    """Prepare the expensive per-player rollup before a profile is opened."""
    try:
        get_darts_player_stats()
    except (DartsFeedUnavailable, ValueError, requests.RequestException) as exc:
        print(f"[DARTS STATS] {type(exc).__name__}: Spielerstatistiken werden später erneut vorgeladen.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = BackgroundScheduler()
    scheduler.add_job(close_expired_cycles, "interval", minutes=1)
    scheduler.add_job(collect_playback_history, "interval", seconds=30, max_instances=1, next_run_time=datetime.now(timezone.utc))
    scheduler.add_job(poll_darts_push_events, "interval", seconds=45, max_instances=1, next_run_time=datetime.now(timezone.utc))
    scheduler.add_job(sync_darts_live_groups, "interval", seconds=10, max_instances=1, coalesce=True, next_run_time=datetime.now(timezone.utc) + timedelta(seconds=2))
    scheduler.add_job(deliver_darts_live_events, "interval", seconds=2, max_instances=1, coalesce=True)
    scheduler.add_job(warm_darts_season, "interval", minutes=9, max_instances=1, coalesce=True, next_run_time=datetime.now(timezone.utc) + timedelta(seconds=12))
    scheduler.add_job(warm_darts_player_stats, "interval", minutes=55, max_instances=1, coalesce=True, next_run_time=datetime.now(timezone.utc) + timedelta(seconds=35))
    scheduler.start()
    yield
    darts_live_hub.stop()
    scheduler.shutdown()


app = FastAPI(title="ClubIQ Music Voting API", lifespan=lifespan)
app.mount("/pics", StaticFiles(directory="pics"), name="pics")
app.mount("/static", StaticFiles(directory="static"), name="static")

DARTS_PUBLIC_HOST = "barverdarts.clubiq.party"


def is_darts_host(request: Request) -> bool:
    return (request.url.hostname or "").lower() == DARTS_PUBLIC_HOST


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    frame_sources = "https://www.youtube-nocookie.com"
    if request.url.path == "/darts" or is_darts_host(request):
        frame_sources = "https://portal.3k-darts.com https://live.3k-darts.com"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        f"script-src 'self'; connect-src 'self'; frame-src {frame_sources}; "
        "base-uri 'none'; frame-ancestors 'none'"
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


class DartsPushKeys(BaseModel):
    p256dh: str = Field(min_length=16, max_length=256)
    auth: str = Field(min_length=16, max_length=256)


class DartsPushSubscribe(BaseModel):
    endpoint: str = Field(min_length=20, max_length=2048)
    expirationTime: int | None = None
    keys: DartsPushKeys
    teams: list[str] = Field(default_factory=lambda: ["A", "B", "C", "D"], max_length=4)
    players: list[str] = Field(default_factory=list, max_length=100)
    eventTypes: list[str] = Field(default_factory=lambda: sorted(PUSH_EVENT_TYPES), max_length=5)


class DartsPushUnsubscribe(BaseModel):
    endpoint: str = Field(min_length=20, max_length=2048)


class DartsPlayerProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=100)
    team: str | None = Field(default=None, pattern=r"^[A-D]$")
    role: str | None = Field(default=None, max_length=50)
    player_number: str | None = Field(default=None, max_length=12, pattern=r"^[A-Za-z0-9]*$")
    alias: str | None = Field(default=None, max_length=50)
    gender: str | None = Field(default=None, pattern=r"^(female|male|diverse)?$")
    darts: str | None = Field(default=None, max_length=80)
    weight_grams: float | None = Field(default=None, ge=10, le=60)
    favorite_pdc_player: str | None = Field(default=None, max_length=80)
    favorite_finish: str | None = Field(default=None, max_length=30)
    finish_route: str | None = Field(default=None, max_length=80)
    walk_on_song: str | None = Field(default=None, max_length=100)
    published: bool = False


class DartsPlayerCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    team: str = Field(pattern=r"^[A-D]$")
    role: str = Field(default="Spieler", max_length=50)


class DartsRosterMember(BaseModel):
    player_id: int = Field(gt=0)
    name: str = Field(min_length=2, max_length=100)
    team: str = Field(pattern=r"^[A-D]$")
    role: str = Field(default="Spieler", max_length=50)


class DartsRosterCacheUpdate(BaseModel):
    players: list[DartsRosterMember] = Field(max_length=100)


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
def read_root(request: Request):
    return FileResponse("darts.html" if is_darts_host(request) else "index.html")


@app.get("/remote")
def dj_remote():
    return FileResponse("remote.html")


@app.get("/party")
def party_display():
    return FileResponse("party.html")


@app.get("/darts")
def darts_display():
    return FileResponse("darts.html")


@app.get("/darts-admin")
def darts_admin_display():
    return FileResponse(
        "darts-admin.html",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.get("/impressum")
def legal_notice():
    return FileResponse("impressum.html")


@app.get("/datenschutz")
def privacy_notice():
    return FileResponse("datenschutz.html")


@app.get("/api/v1/darts/ticker")
def darts_ticker():
    try:
        return get_darts_feed()
    except DartsFeedUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/darts/live")
def darts_live_snapshot():
    """Normalized server-side state; browsers never connect to 3K directly."""
    return darts_live_hub.snapshot()


@app.get("/api/v1/darts/live/stream")
def darts_live_stream():
    channel = darts_live_hub.subscribe()

    async def messages():
        try:
            yield "retry: 5000\n"
            yield f"event: snapshot\ndata: {json.dumps(darts_live_hub.snapshot(), ensure_ascii=False, separators=(',', ':'))}\n\n"
            while True:
                message = None
                for _ in range(20):
                    try:
                        message = channel.get_nowait()
                        break
                    except queue.Empty:
                        await asyncio.sleep(1)
                if message:
                    event_name = "status" if message.get("type") == "live-status" else "update"
                    yield f"event: {event_name}\ndata: {json.dumps(message, ensure_ascii=False, separators=(',', ':'))}\n\n"
                else:
                    yield ": ClubIQ live heartbeat\n\n"
        finally:
            darts_live_hub.unsubscribe(channel)

    return StreamingResponse(
        messages(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.get("/api/v1/darts/live/{group_key}")
def darts_live_group(group_key: int):
    group = darts_live_hub.get_group(str(group_key))
    if not group:
        raise HTTPException(status_code=404, detail="Diese Begegnung ist derzeit nicht live.")
    return group


@app.get("/api/v1/darts/center")
def darts_center(league: str = "kl04", round_id: int | None = None):
    try:
        return get_darts_center(league, round_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DartsFeedUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/darts/season")
def darts_season():
    try:
        return get_darts_season()
    except DartsFeedUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/darts/matches/{match_id}")
def darts_match(match_id: int):
    try:
        return get_darts_match(match_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except DartsFeedUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/darts/player-stats")
def darts_player_stats():
    try:
        return get_darts_player_stats()
    except DartsFeedUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _clean_profile_text(value: str | None) -> str | None:
    cleaned = " ".join((value or "").strip().split())
    return cleaned or None


def _base_darts_player_profiles() -> dict[str, dict]:
    try:
        payload = json.loads(Path("static/darts-players.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    players = payload.get("players") if isinstance(payload, dict) else None
    return players if isinstance(players, dict) else {}


def _profile_from_row(row) -> tuple[str, dict]:
    player_id = str(row[0])
    personal = {
        "darts": row[4] or "",
        "weightGrams": float(row[5]) if row[5] is not None else None,
        "favoritePdcPlayer": row[6] or "",
        "favoriteFinish": row[7] or "",
        "finishRoute": row[8] or "",
        "walkOnSong": row[9] or "",
    }
    profile = {
        "playerNumber": row[1] or "",
        "alias": row[2] or "",
        "gender": row[3] or "",
        "personal": personal,
        "published": bool(row[13]),
        "updatedAt": row[15],
        "hasUploadedImage": row[10] is not None,
        "imageVersion": int(row[12] or 0),
        "name": row[16] or "",
        "team": row[17] or "",
        "role": row[18] or "",
    }
    if row[10] is not None:
        profile["image"] = f"/api/v1/darts/players/{player_id}/photo?v={int(row[12] or 0)}"
    return player_id, profile


def _darts_profile_rows() -> dict[str, dict]:
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT player_id, player_number, alias, gender, darts, weight_grams,
                   favorite_pdc_player, favorite_finish, finish_route, walk_on_song,
                   image_data, image_media_type, image_version, published, created_at, updated_at,
                   display_name, team_code, roster_role
            FROM darts_player_profiles
            ORDER BY player_id;
            """
        )
        return dict(_profile_from_row(row) for row in cur.fetchall())


def _darts_roster_rows() -> dict[str, dict]:
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT player_id, display_name, team_code, roster_role FROM darts_roster_cache ORDER BY player_id;"
        )
        return {
            str(row[0]): {"name": row[1], "team": row[2], "role": row[3] or "Spieler"}
            for row in cur.fetchall()
        }


def _public_darts_profiles() -> dict[str, dict]:
    profiles = {str(key): dict(value) for key, value in _base_darts_player_profiles().items() if isinstance(value, dict)}
    for player_id, stored in _darts_profile_rows().items():
        if not stored["published"]:
            profiles.pop(player_id, None)
            continue
        base = profiles.get(player_id, {})
        personal = {key: value for key, value in stored["personal"].items() if value not in (None, "")}
        public = dict(base)
        for key in ("playerNumber", "alias", "gender", "image"):
            if stored.get(key):
                public[key] = stored[key]
            elif key != "image":
                public.pop(key, None)
        for key in ("name", "team", "role"):
            if stored.get(key):
                public[key] = stored[key]
        if any(value not in (None, "") for value in personal.values()):
            public["personal"] = personal
        else:
            public.pop("personal", None)
        profiles[player_id] = public
    return profiles


@app.get("/api/v1/darts/player-profiles")
def darts_player_profiles():
    return Response(
        content=json.dumps({"players": _public_darts_profiles()}, ensure_ascii=False, default=str),
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=60, stale-while-revalidate=300"},
    )


@app.get("/api/v1/darts/admin/players", dependencies=[Depends(require_admin)])
def darts_admin_players():
    base = _base_darts_player_profiles()
    stored = _darts_profile_rows()
    roster = _darts_roster_rows()
    ids = sorted(set(base) | set(stored) | set(roster), key=lambda value: int(value) if value.isdigit() else value)
    players = []
    for player_id in ids:
        source = dict(base.get(player_id) or {})
        source.update(roster.get(player_id) or {})
        database = stored.get(player_id)
        personal = dict(source.get("personal") or {})
        if database:
            personal = dict(database["personal"])
            for key in ("playerNumber", "alias", "gender"):
                source[key] = database.get(key) or ""
            for key in ("name", "team", "role"):
                source[key] = database.get(key) or source.get(key) or ""
            if database.get("image"):
                source["image"] = database["image"]
        source["personal"] = personal
        source.update({
            "playerId": int(player_id),
            "published": database["published"] if database else True,
            "stored": database is not None,
            "hasUploadedImage": bool(database and database["hasUploadedImage"]),
        })
        players.append(source)
    return Response(
        content=json.dumps({"players": players}, ensure_ascii=False, default=str),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/v1/darts/admin/players", dependencies=[Depends(require_admin)])
def darts_admin_create_player(player: DartsPlayerCreate):
    name = _clean_profile_text(player.name)
    role = _clean_profile_text(player.role) or "Spieler"
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(2026092701);")
        cur.execute(
            "SELECT COALESCE(MAX(player_id), 899999999999) + 1 FROM darts_player_profiles WHERE player_id BETWEEN 900000000000 AND 999999999998;"
        )
        player_id = int(cur.fetchone()[0])
        if player_id > 999999999999:
            raise HTTPException(status_code=409, detail="Es können derzeit keine weiteren lokalen Profile angelegt werden.")
        cur.execute(
            """
            INSERT INTO darts_player_profiles (player_id, display_name, team_code, roster_role, published)
            VALUES (%s,%s,%s,%s,FALSE);
            """,
            (player_id, name, player.team, role),
        )
        cur.execute(
            "INSERT INTO darts_player_profile_audit (player_id, action, detail_json) VALUES (%s, 'profile_created', %s::jsonb);",
            (player_id, json.dumps({"name": name, "team": player.team}, ensure_ascii=False, separators=(",", ":"))),
        )
        conn.commit()
    return {"status": "success", "player_id": player_id}


@app.post("/api/v1/darts/admin/roster-cache", dependencies=[Depends(require_admin)])
def darts_admin_cache_roster(update: DartsRosterCacheUpdate):
    """Persist public roster labels so the editor remains useful during a 3K outage."""
    with db_connect() as conn, conn.cursor() as cur:
        for player in update.players:
            cur.execute(
                """
                INSERT INTO darts_roster_cache (player_id, display_name, team_code, roster_role)
                VALUES (%s,%s,%s,%s)
                ON CONFLICT (player_id) DO UPDATE SET
                    display_name=EXCLUDED.display_name,
                    team_code=EXCLUDED.team_code,
                    roster_role=EXCLUDED.roster_role,
                    updated_at=CURRENT_TIMESTAMP;
                """,
                (
                    player.player_id,
                    _clean_profile_text(player.name),
                    player.team,
                    _clean_profile_text(player.role) or "Spieler",
                ),
            )
        conn.commit()
    return {"status": "success", "cached": len(update.players)}


@app.put("/api/v1/darts/admin/players/{player_id}", dependencies=[Depends(require_admin)])
def darts_admin_update_player(player_id: int, update: DartsPlayerProfileUpdate):
    values = {
        "display_name": _clean_profile_text(update.display_name),
        "team_code": _clean_profile_text(update.team),
        "roster_role": _clean_profile_text(update.role),
        "player_number": _clean_profile_text(update.player_number),
        "alias": _clean_profile_text(update.alias),
        "gender": _clean_profile_text(update.gender),
        "darts": _clean_profile_text(update.darts),
        "weight_grams": update.weight_grams,
        "favorite_pdc_player": _clean_profile_text(update.favorite_pdc_player),
        "favorite_finish": _clean_profile_text(update.favorite_finish),
        "finish_route": _clean_profile_text(update.finish_route),
        "walk_on_song": _clean_profile_text(update.walk_on_song),
        "published": update.published,
    }
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO darts_player_profiles (
                player_id, display_name, team_code, roster_role, player_number, alias, gender, darts, weight_grams,
                favorite_pdc_player, favorite_finish, finish_route, walk_on_song, published
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (player_id) DO UPDATE SET
                display_name=EXCLUDED.display_name,
                team_code=EXCLUDED.team_code,
                roster_role=EXCLUDED.roster_role,
                player_number=EXCLUDED.player_number, alias=EXCLUDED.alias,
                gender=EXCLUDED.gender, darts=EXCLUDED.darts,
                weight_grams=EXCLUDED.weight_grams,
                favorite_pdc_player=EXCLUDED.favorite_pdc_player,
                favorite_finish=EXCLUDED.favorite_finish,
                finish_route=EXCLUDED.finish_route,
                walk_on_song=EXCLUDED.walk_on_song,
                published=EXCLUDED.published, updated_at=CURRENT_TIMESTAMP;
            """,
            (player_id, *values.values()),
        )
        cur.execute(
            "INSERT INTO darts_player_profile_audit (player_id, action, detail_json) VALUES (%s, 'profile_saved', %s::jsonb);",
            (player_id, json.dumps({"published": update.published}, separators=(",", ":"))),
        )
        conn.commit()
    return {"status": "success", "player_id": player_id, "published": update.published}


def _validated_player_image(data: bytes) -> tuple[str, bytes]:
    if not data:
        raise HTTPException(status_code=422, detail="Bitte ein Bild auswählen.")
    if len(data) > 3 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Das optimierte Bild darf höchstens 3 MB groß sein.")
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", data
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", data
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", data
    raise HTTPException(status_code=422, detail="Erlaubt sind JPEG-, PNG- und WebP-Bilder.")


@app.post("/api/v1/darts/admin/players/{player_id}/photo", dependencies=[Depends(require_admin)])
async def darts_admin_upload_player_photo(player_id: int, photo: UploadFile = File(...)):
    media_type, data = _validated_player_image(await photo.read(3 * 1024 * 1024 + 1))
    version = int(datetime.now(timezone.utc).timestamp())
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO darts_player_profiles (player_id, image_data, image_media_type, image_version)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (player_id) DO UPDATE SET image_data=EXCLUDED.image_data,
                image_media_type=EXCLUDED.image_media_type, image_version=EXCLUDED.image_version,
                updated_at=CURRENT_TIMESTAMP;
            """,
            (player_id, data, media_type, version),
        )
        cur.execute(
            "INSERT INTO darts_player_profile_audit (player_id, action) VALUES (%s, 'photo_uploaded');",
            (player_id,),
        )
        conn.commit()
    return {"status": "success", "image": f"/api/v1/darts/players/{player_id}/photo?v={version}"}


@app.delete("/api/v1/darts/admin/players/{player_id}/photo", dependencies=[Depends(require_admin)])
def darts_admin_delete_player_photo(player_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE darts_player_profiles SET image_data=NULL, image_media_type=NULL,
               image_version=image_version+1, updated_at=CURRENT_TIMESTAMP WHERE player_id=%s;""",
            (player_id,),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Spielerprofil nicht gefunden.")
        cur.execute(
            "INSERT INTO darts_player_profile_audit (player_id, action) VALUES (%s, 'photo_deleted');",
            (player_id,),
        )
        conn.commit()
    return {"status": "success"}


@app.get("/api/v1/darts/players/{player_id}/photo")
def darts_player_photo(player_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT image_data, image_media_type, image_version FROM darts_player_profiles WHERE player_id=%s AND published=TRUE;",
            (player_id,),
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        raise HTTPException(status_code=404, detail="Kein veröffentlichtes Spielerbild vorhanden.")
    return Response(
        content=bytes(row[0]), media_type=row[1] or "image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable", "ETag": f'"{player_id}-{row[2]}"'},
    )


@app.get("/api/v1/darts/members")
def darts_members():
    """Public directory: names only; never expose account or authentication data."""
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT display_name FROM club_members WHERE active = TRUE ORDER BY lower(display_name);"
        )
        return {"members": [row[0] for row in cur.fetchall()]}


@app.get("/api/v1/darts/push/config")
def darts_push_config():
    return {
        "available": bool(DARTS_VAPID_PUBLIC_KEY and DARTS_VAPID_PRIVATE_KEY and webpush),
        "publicKey": DARTS_VAPID_PUBLIC_KEY,
    }


@app.get("/api/v1/darts/push/status")
def darts_push_status():
    status = dict(_darts_push_status)
    try:
        with db_connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM darts_push_subscriptions WHERE enabled = TRUE;")
            status["subscriptions"] = int(cur.fetchone()[0])
    except psycopg.Error:
        status["subscriptions"] = None
    return status


def require_push_intent(x_clubiq_push: str | None) -> None:
    if x_clubiq_push != "1":
        raise HTTPException(status_code=403, detail="Push-Aktion nicht bestätigt.")


@app.post("/api/v1/darts/push/subscribe", status_code=201)
def darts_push_subscribe(payload: DartsPushSubscribe, x_clubiq_push: str | None = Header(default=None)):
    require_push_intent(x_clubiq_push)
    if not DARTS_VAPID_PUBLIC_KEY or not DARTS_VAPID_PRIVATE_KEY or webpush is None:
        raise HTTPException(status_code=503, detail="Push-Benachrichtigungen sind noch nicht eingerichtet.")
    try:
        endpoint = valid_push_endpoint(payload.endpoint)
        p256dh = valid_push_key(payload.keys.p256dh)
        auth = valid_push_key(payload.keys.auth)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    teams = sorted(set(payload.teams))
    if any(team not in {"A", "B", "C", "D"} for team in teams):
        raise HTTPException(status_code=422, detail="Ungültige Mannschaftsauswahl.")
    players = sorted(set(name.strip() for name in payload.players))
    event_types = sorted(set(payload.eventTypes))
    if any(not name or len(name) > 100 for name in players) or any(kind not in PUSH_EVENT_TYPES for kind in event_types):
        raise HTTPException(status_code=422, detail="Ungültige Meldungsauswahl.")
    endpoint_hash = hashlib.sha256(endpoint.encode("utf-8")).hexdigest()
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO darts_push_subscriptions (endpoint, endpoint_hash, p256dh, auth, teams, players, event_types, enabled)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, TRUE)
            ON CONFLICT (endpoint) DO UPDATE SET
              endpoint_hash = EXCLUDED.endpoint_hash,
              p256dh = EXCLUDED.p256dh,
              auth = EXCLUDED.auth,
              teams = EXCLUDED.teams,
              players = EXCLUDED.players,
              event_types = EXCLUDED.event_types,
              enabled = TRUE,
              updated_at = CURRENT_TIMESTAMP;
            """,
            (endpoint, endpoint_hash, p256dh, auth, json.dumps(teams), json.dumps(players), json.dumps(event_types)),
        )
        conn.commit()
    return {"ok": True, "teams": teams}


@app.get("/api/v1/darts/highlights")
def darts_highlights():
    """Public sporting moments, never browser endpoints or subscription data."""
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("""SELECT event_id, event_type, team, player, match_id, payload, occurred_at
                       FROM darts_push_events WHERE payload IS NOT NULL
                       AND occurred_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
                       ORDER BY occurred_at DESC, first_seen_at DESC LIMIT 60;""")
        return {"items": [{"id": row[0], "type": row[1], "team": row[2], "player": row[3],
                           "matchId": row[4], **row[5], "occurredAt": row[6].isoformat()} for row in cur.fetchall()]}


@app.post("/api/v1/darts/push/unsubscribe")
def darts_push_unsubscribe(payload: DartsPushUnsubscribe, x_clubiq_push: str | None = Header(default=None)):
    require_push_intent(x_clubiq_push)
    try:
        endpoint = valid_push_endpoint(payload.endpoint)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM darts_push_subscriptions WHERE endpoint = %s;", (endpoint,))
        conn.commit()
    return {"ok": True}


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
        results = [
            {
                "external_id": item["id"]["videoId"],
                "title": html.unescape(item["snippet"]["title"]),
                "channel_title": html.unescape(item["snippet"]["channelTitle"]),
                "thumbnail_url": f"/api/v1/music/thumbnails/youtube/{item['id']['videoId']}",
            }
            for item in items
        ]
        if not results:
            return []
        # One batched metadata request, never one request per search result.
        try:
            metadata = requests.get("https://www.googleapis.com/youtube/v3/videos",
                params={"part": "contentDetails", "id": ",".join(s["external_id"] for s in results), "key": YOUTUBE_API_KEY}, timeout=4)
            metadata.raise_for_status()
            durations = {item["id"]: duration_ms(item.get("contentDetails", {}).get("duration")) for item in metadata.json().get("items", [])}
        except (requests.RequestException, ValueError, KeyError, TypeError):
            durations = {}
        return [{**song, "duration_ms": durations.get(song["external_id"])} for song in results]
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


def recent_playlist_candidates(
    cur, cycle_id: int, starts_at, *, include_unvoted: bool = True
) -> tuple[list[dict], list[dict]]:
    """Collect unique YouTube songs from the five latest completed rounds."""
    cur.execute(
        """
        SELECT c.id, c.name, p.items_json
        FROM music_cycles c
        LEFT JOIN music_cycle_playlists p ON p.cycle_id = c.id
        WHERE c.id <> %s AND c.starts_at < %s
          AND (c.status = 'closed' OR c.closes_at <= CURRENT_TIMESTAMP)
        ORDER BY c.starts_at DESC, c.id DESC
        LIMIT %s;
        """,
        (cycle_id, starts_at, PREVIOUS_PLAYLIST_LIMIT),
    )
    previous_cycles = cur.fetchall()
    summaries: list[dict] = []
    songs: list[dict] = []
    seen: set[str] = set()
    for previous_id, previous_name, stored_items in previous_cycles:
        items = stored_items
        if isinstance(items, str):
            items = json.loads(items)
        if not isinstance(items, list) or not items:
            cur.execute(
                """
                SELECT s.title, s.channel_title, s.external_id
                FROM music_suggestions s
                LEFT JOIN music_votes v ON v.suggestion_id = s.id
                WHERE s.cycle_id = %s AND s.status = 'approved' AND s.provider = 'youtube'
                GROUP BY s.id
                HAVING %s OR COALESCE(SUM(v.points), 0) > 0
                ORDER BY COALESCE(SUM(v.points), 0) DESC, s.created_at ASC, s.id ASC
                LIMIT 50;
                """,
                (previous_id, include_unvoted),
            )
            items = [
                {"title": row[0], "artist": row[1], "external_id": row[2]}
                for row in cur.fetchall()
            ]
        added = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            external_id = str(item.get("external_id", ""))
            if external_id in seen or not YOUTUBE_VIDEO_ID.fullmatch(external_id):
                continue
            seen.add(external_id)
            added += 1
            songs.append({
                "external_id": external_id,
                "title": str(item.get("title") or "Song")[:255],
                "channel_title": str(item.get("artist") or item.get("channel_title") or "")[:255],
                "artist": str(item.get("artist") or item.get("channel_title") or "")[:255],
                "provider": "youtube",
                "thumbnail_url": f"/api/v1/music/thumbnails/youtube/{external_id}",
                "source_cycle_id": previous_id,
                "source_cycle_name": previous_name,
            })
        summaries.append({"id": previous_id, "name": previous_name, "song_count": added})
    return summaries, songs


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
                   COALESCE(MAX(v.points) FILTER (WHERE v.member_id = %s), 0), s.duration_ms
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
            "duration_ms": row[8] if len(row) > 8 else None,
        })
    return {"playlist": playlist}


@app.get("/api/v1/music/cycles/{cycle_id}/previous-playlist")
def get_previous_playlist(cycle_id: int):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT starts_at FROM music_cycles WHERE id = %s;", (cycle_id,))
        current = cur.fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Abstimmung nicht gefunden.")
        cycles, songs = recent_playlist_candidates(cur, cycle_id, current[0])
    latest = cycles[0] if cycles else None
    return {"cycle": latest, "cycles": cycles, "songs": songs}


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


def queue_cycle_ranking(cycle_id: int | None, member: dict, *, prepare_only=False):
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
                return send_ranked_playlist(generated, cycle_id, name, target, use_genre, fallback_genre, member, True, prepare_only=prepare_only)
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
            _, previous_playlist = recent_playlist_candidates(
                cur, cycle_id, starts_at, include_unvoted=False
            )

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
    return send_ranked_playlist(generated, cycle_id, name, target, use_genre, fallback_genre, member, archived, prepare_only=prepare_only)


def send_ranked_playlist(generated, cycle_id, name, target, use_genre, fallback_genre, member, archived, *, prepare_only=False):
    items = [player_item(item) for item in generated]
    if prepare_only:
        if not items:
            raise HTTPException(409, "Diese Playlist enthält noch keine abspielbaren Titel.")
        return items
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


@app.get("/api/v1/music/player/bluetooth/saved")
def saved_bluetooth_speakers(_member: dict = Depends(require_player_operator)):
    return player_agent("GET", "/bluetooth/saved", timeout=30)


@app.post("/api/v1/music/player/bluetooth/reconnect")
def reconnect_saved_speaker(device: BluetoothDeviceAction, _member: dict = Depends(require_player_operator)):
    # The native agent rechecks the bond and never pairs unknown devices here.
    return player_agent("POST", "/bluetooth/reconnect", device.model_dump(), timeout=60)


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


collect_playback_history = register_library(app, db_connect, require_member, player_agent, lambda: bool(PLAYER_AGENT_TOKEN))


class EveningStart(BaseModel):
    request_id: UUID
    address: str = Field(pattern=r"^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$")
    volume: int = Field(ge=0, le=100)
    cycle_id: int | None = Field(default=None, ge=1)
    station_id: int | None = Field(default=None, ge=1)
    fallback_station_id: int | None = Field(default=None, ge=1)


def active_station(station_id):
    if station_id is None:
        return None
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id,name,stream_url,fallback_url,logo_url,genre,active,sort_order FROM music_radio_stations WHERE id=%s AND active=TRUE;", (station_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Radiosender nicht mehr verfügbar.")
        return radio_station_dict(row)


@app.post("/api/v1/music/player/evening/start")
def start_evening(data: EveningStart, member: dict = Depends(require_player_operator)):
    if (data.cycle_id is None) == (data.station_id is None):
        raise HTTPException(422, "Bitte genau eine Musikquelle auswählen.")
    if data.station_id and data.fallback_station_id:
        raise HTTPException(422, "Ein Ersatzsender ist nur für Playlists vorgesehen.")
    station = active_station(data.station_id)
    fallback = active_station(data.fallback_station_id)
    items = queue_cycle_ranking(data.cycle_id, member, prepare_only=True) if data.cycle_id else []
    result = player_agent("POST", "/evening/start", {
        "request_id": str(data.request_id), "address": data.address.upper(),
        "volume": data.volume, "items": items, "station": station, "fallback_station": fallback,
    }, timeout=100)
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO music_player_audit (member_id,action,detail_json) VALUES (%s,'evening_start',%s);",
                    (member["member_id"], json.dumps({"cycle_id": data.cycle_id, "station_id": data.station_id, "fallback_station_id": data.fallback_station_id, "volume": data.volume})))
        conn.commit()
    return result


@app.post("/api/v1/music/player/fallback/disable")
def disable_fallback(member: dict = Depends(require_player_operator)):
    return player_agent("POST", "/fallback/disable")
