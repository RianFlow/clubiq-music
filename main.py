from __future__ import annotations

import hashlib
import html
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db_config import connection_kwargs

load_dotenv()

DEFAULT_MAX_BUDGET = int(os.getenv("MAX_BUDGET", "10"))
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
SESSION_DAYS = max(1, int(os.getenv("SESSION_DAYS", "30")))
PIN_ITERATIONS = 210_000


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
            SELECT m.member_id, m.display_name
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
    return {"member_id": row[0], "display_name": row[1], "token_hash": token_hash(token)}


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
                "WHERE status = 'active' AND closes_at <= CURRENT_TIMESTAMP;"
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


class MemberAdminCreate(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    pin: str = Field(pattern=r"^\d{4,8}$")


class MemberAdminUpdate(BaseModel):
    pin: str | None = Field(default=None, pattern=r"^\d{4,8}$")
    active: bool | None = None


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
    duration_days: int = Field(default=7, ge=1, le=90)
    max_budget: int = Field(default=DEFAULT_MAX_BUDGET, ge=1, le=100)


class CycleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    status: str | None = None
    closes_at: datetime | None = None
    max_budget: int | None = Field(default=None, ge=1, le=100)


@app.get("/")
def read_root():
    return FileResponse("index.html")


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
            SELECT member_id, display_name, pin_hash, active
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
            "SELECT id, name, max_budget FROM music_cycles WHERE status = 'active' ORDER BY id DESC LIMIT 1;"
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
        "member": {"member_id": member_id, "display_name": display_name},
        "budget": {"remaining": max(0, maximum - used), "maximum": maximum},
        "active_cycle_id": cycle[0] if cycle else None,
        "pin_created": first_pin,
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
            "SELECT id, name, max_budget FROM music_cycles WHERE status = 'active' ORDER BY id DESC LIMIT 1;"
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
        "member": {"member_id": member["member_id"], "display_name": member["display_name"]},
        "active_cycle_id": cycle[0] if cycle else None,
        "budget": {"remaining": max(0, maximum - used), "maximum": maximum},
    }


@app.get("/api/v1/music/provider/search")
def search_tracks(
    q: str = Query(min_length=3, max_length=100),
    _member: dict = Depends(require_member),
):
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
        return {
            "results": [
                {
                    "external_id": item["id"]["videoId"],
                    "title": html.unescape(item["snippet"]["title"]),
                    "channel_title": html.unescape(item["snippet"]["channelTitle"]),
                }
                for item in items
            ]
        }
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Musiksuche ist derzeit nicht erreichbar.") from exc


@app.get("/api/v1/music/cycles")
def get_cycles():
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, status, starts_at, closes_at, max_budget FROM music_cycles ORDER BY id DESC;"
        )
        return {
            "cycles": [
                {
                    "id": row[0], "name": row[1], "status": row[2], "starts_at": row[3],
                    "closes_at": row[4], "max_budget": row[5],
                }
                for row in cur.fetchall()
            ]
        }


@app.get("/api/v1/music/cycles/{cycle_id}/playlist")
def get_playlist(cycle_id: int, member: dict = Depends(require_member)):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT s.id, s.title, s.channel_title, s.member_id,
                   COALESCE(SUM(v.points), 0),
                   COALESCE(MAX(v.points) FILTER (WHERE v.member_id = %s), 0)
            FROM music_suggestions s
            LEFT JOIN music_votes v ON s.id = v.suggestion_id
            WHERE s.cycle_id = %s AND s.status = 'approved'
            GROUP BY s.id
            ORDER BY COALESCE(SUM(v.points), 0) DESC, s.created_at ASC;
            """,
            (member["member_id"], cycle_id),
        )
        rows = cur.fetchall()
    return {
        "playlist": [
            {
                "rank": rank, "suggestion_id": row[0], "title": row[1],
                "channel_title": row[2], "suggested_by_me": row[3] == member["member_id"],
                "total_points": int(row[4]), "my_points": int(row[5]),
            }
            for rank, row in enumerate(rows, start=1)
        ]
    }


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
            WHERE s.id = %s AND s.cycle_id = %s AND c.status = 'active' AND s.status = 'approved';
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
            SELECT member_id, display_name, active, pin_hash IS NOT NULL, created_at
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
                active = COALESCE(%s, active)
            WHERE member_id = %s;
            """,
            (pin_hash, update.active, member_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Mitglied nicht gefunden.")
        if update.pin is not None or update.active is False:
            cur.execute("DELETE FROM music_member_sessions WHERE member_id = %s;", (member_id,))
        conn.commit()
    return {"status": "success"}


@app.post("/api/v1/music/admin/cycles", dependencies=[Depends(require_admin)])
def create_cycle(cycle: CycleCreate):
    with db_connect() as conn, conn.cursor() as cur:
        cur.execute("UPDATE music_cycles SET status = 'closed' WHERE status = 'active';")
        cur.execute(
            """
            INSERT INTO music_cycles
                (name, type, profile_id, starts_at, closes_at, status, max_budget)
            VALUES (%s, 'custom', 1, CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + (%s * INTERVAL '1 day'), 'active', %s)
            RETURNING id;
            """,
            (cycle.name.strip(), cycle.duration_days, cycle.max_budget),
        )
        cycle_id = cur.fetchone()[0]
        conn.commit()
    return {"status": "success", "cycle_id": cycle_id}


@app.patch("/api/v1/music/admin/cycles/{cycle_id}", dependencies=[Depends(require_admin)])
def update_cycle(cycle_id: int, update: CycleUpdate):
    if update.status not in {None, "planned", "active", "closed"}:
        raise HTTPException(status_code=400, detail="Ungültiger Status.")
    with db_connect() as conn, conn.cursor() as cur:
        if update.status == "active":
            cur.execute("UPDATE music_cycles SET status = 'closed' WHERE status = 'active' AND id <> %s;", (cycle_id,))
        cur.execute(
            """
            UPDATE music_cycles
            SET name = COALESCE(%s, name), status = COALESCE(%s, status),
                closes_at = COALESCE(%s, closes_at), max_budget = COALESCE(%s, max_budget),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s;
            """,
            (update.name, update.status, update.closes_at, update.max_budget, cycle_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="Abstimmung nicht gefunden.")
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
            WHERE id = %s AND status = 'active' RETURNING id;
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
