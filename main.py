from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import psycopg
import os
from dotenv import load_dotenv
import requests
import secrets
from contextlib import asynccontextmanager
from apscheduler.schedulers.background import BackgroundScheduler

from db_config import connection_kwargs

load_dotenv()

MAX_BUDGET = int(os.getenv("MAX_BUDGET", 10))
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

def db_connect():
    return psycopg.connect(**connection_kwargs())


def require_admin(x_admin_password: str | None = Header(default=None)) -> None:
    if not ADMIN_PASSWORD:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ADMIN_PASSWORD ist auf dem Server noch nicht eingerichtet.",
        )
    if not x_admin_password or not secrets.compare_digest(x_admin_password, ADMIN_PASSWORD):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Verwaltungskennwort ungültig.",
        )

def close_expired_cycles():
    try:
        with db_connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, name FROM music_cycles WHERE status = 'active' AND closes_at <= CURRENT_TIMESTAMP;")
                expired_cycles = cur.fetchall()
                for cycle in expired_cycles:
                    cur.execute("UPDATE music_cycles SET status = 'closed' WHERE id = %s;", (cycle[0],))
                conn.commit()
    except Exception as e:
        print(f"[BACKGROUND ERROR] {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler = BackgroundScheduler()
    scheduler.add_job(close_expired_cycles, 'interval', minutes=1)
    scheduler.start()
    yield
    scheduler.shutdown()

app = FastAPI(title="Clubiq Music Voting API", lifespan=lifespan)
app.mount("/pics", StaticFiles(directory="pics"), name="pics")

class CycleUpdate(BaseModel):
    name: str | None = None
    status: str | None = None
    closes_at: str | None = None

class MemberLogin(BaseModel):
    member_id: str
    display_name: str | None = None

class SuggestionCreate(BaseModel):
    member_id: str
    provider: str = "youtube"
    external_id: str
    title: str
    channel_title: str | None = None
    duration_ms: int | None = None

class VoteCreate(BaseModel):
    member_id: str
    suggestion_id: int
    points: int

@app.get("/")
def read_root():
    return FileResponse("index.html")


@app.get("/health")
def health():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1;")
            cur.fetchone()
    return {"status": "ok"}

@app.post("/api/v1/music/auth/login")
def member_login(login: MemberLogin):
    m_id = login.member_id.strip().lower().replace(" ", "_")
    d_name = (login.display_name or login.member_id).strip()
    if not m_id or not d_name:
        raise HTTPException(status_code=400, detail="Name fehlt.")
    try:
        with db_connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO club_members (member_id, display_name) VALUES (%s, %s) 
                               ON CONFLICT (member_id) DO UPDATE SET display_name = EXCLUDED.display_name 
                               RETURNING id, member_id, display_name;""", (m_id, d_name))
                row = cur.fetchone()
                cur.execute("SELECT id FROM music_cycles WHERE status = 'active' ORDER BY id DESC LIMIT 1;")
                active_cycle = cur.fetchone()
                cycle_id = active_cycle[0] if active_cycle else None
                cur.execute(
                    "SELECT COALESCE(SUM(points), 0) FROM music_votes WHERE cycle_id = %s AND member_id = %s;",
                    (cycle_id, m_id),
                )
                used_budget = int(cur.fetchone()[0])
                conn.commit()
                return {
                    "status": "success",
                    "member": {"id": row[0], "member_id": row[1], "display_name": row[2]},
                    "budget": {"remaining": max(0, MAX_BUDGET - used_budget), "maximum": MAX_BUDGET},
                    "active_cycle_id": cycle_id,
                }
    except psycopg.Error as exc:
        raise HTTPException(status_code=500, detail="Mitglieder-Anmeldung fehlgeschlagen.") from exc

@app.get("/api/v1/music/provider/search")
def search_tracks(q: str):
    try:
        url = "https://www.googleapis.com/youtube/v3/search"
        params = {"part": "snippet", "q": q, "type": "video", "maxResults": 5, "key": YOUTUBE_API_KEY}
        if not YOUTUBE_API_KEY:
            raise HTTPException(status_code=503, detail="YouTube-Suche ist noch nicht eingerichtet.")
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        items = response.json().get("items", [])
        return {"results": [{"external_id": i["id"]["videoId"], "title": i["snippet"]["title"], "channel_title": i["snippet"]["channelTitle"]} for i in items]}
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Musiksuche ist derzeit nicht erreichbar.") from exc

@app.post("/api/v1/music/cycles/{cycle_id}/suggestions")
def create_suggestion(cycle_id: int, suggestion: SuggestionCreate):
    member_id = suggestion.member_id.strip().lower()
    title = suggestion.title.strip()
    external_id = suggestion.external_id.strip()
    if not member_id or not title or not external_id:
        raise HTTPException(status_code=400, detail="Mitglied und Songangaben müssen vollständig sein.")
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO music_suggestions (
                    cycle_id, member_id, provider, external_id, title, channel_title, duration_ms
                )
                SELECT %s, %s, %s, %s, %s, %s, %s
                FROM music_cycles c
                JOIN club_members m ON m.member_id = %s
                WHERE c.id = %s AND c.status = 'active'
                RETURNING id;
                """,
                (
                    cycle_id,
                    member_id,
                    suggestion.provider,
                    external_id,
                    title,
                    suggestion.channel_title,
                    suggestion.duration_ms,
                    member_id,
                    cycle_id,
                ),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=409, detail="Dieser Voting-Zeitraum ist nicht aktiv.")
            conn.commit()
            return {"message": "Success", "suggestion_id": row[0]}

@app.get("/api/v1/music/cycles/{cycle_id}/playlist")
def get_playlist(cycle_id: int):
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT s.id, s.title, s.channel_title, COALESCE(SUM(v.points), 0) FROM music_suggestions s LEFT JOIN music_votes v ON s.id = v.suggestion_id WHERE s.cycle_id = %s GROUP BY s.id ORDER BY SUM(v.points) DESC;", (cycle_id,))
            rows = cur.fetchall()
            return {
                "playlist": [
                    {
                        "rank": rank,
                        "suggestion_id": row[0],
                        "title": row[1],
                        "channel_title": row[2],
                        "total_points": row[3],
                    }
                    for rank, row in enumerate(rows, start=1)
                ]
            }


@app.get("/api/v1/music/cycles")
def get_cycles():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, name, status, closes_at FROM music_cycles ORDER BY id DESC;")
            return {
                "cycles": [
                    {"id": row[0], "name": row[1], "status": row[2], "closes_at": row[3]}
                    for row in cur.fetchall()
                ]
            }


@app.get("/api/v1/music/cycles/{cycle_id}/suggestions", dependencies=[Depends(require_admin)])
def get_suggestions(cycle_id: int):
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT s.id, s.title, s.member_id, COALESCE(SUM(v.points), 0)
                FROM music_suggestions s
                LEFT JOIN music_votes v ON v.suggestion_id = s.id
                WHERE s.cycle_id = %s
                GROUP BY s.id
                ORDER BY s.id DESC;
                """,
                (cycle_id,),
            )
            return {
                "suggestions": [
                    {
                        "suggestion_id": row[0],
                        "title": row[1],
                        "member_id": row[2],
                        "total_points": row[3],
                    }
                    for row in cur.fetchall()
                ]
            }

@app.post("/api/v1/music/cycles/{cycle_id}/votes")
def cast_vote(cycle_id: int, vote: VoteCreate):
    if vote.points < 1 or vote.points > MAX_BUDGET:
        raise HTTPException(status_code=400, detail="Ungültige Punktezahl.")
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s));",
                (f"{cycle_id}:{vote.member_id}",),
            )
            cur.execute(
                """
                SELECT 1
                FROM music_suggestions s
                JOIN music_cycles c ON c.id = s.cycle_id
                JOIN club_members m ON m.member_id = %s
                WHERE s.id = %s AND s.cycle_id = %s AND c.status = 'active';
                """,
                (vote.member_id, vote.suggestion_id, cycle_id),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=409, detail="Mitglied, Song oder Voting-Zeitraum ist ungültig.")
            cur.execute(
                """
                SELECT COALESCE(SUM(points), 0)
                FROM music_votes
                WHERE cycle_id = %s AND member_id = %s AND suggestion_id <> %s;
                """,
                (cycle_id, vote.member_id, vote.suggestion_id),
            )
            other_points = int(cur.fetchone()[0])
            if other_points + vote.points > MAX_BUDGET:
                raise HTTPException(status_code=400, detail="Dein Punktebudget reicht dafür nicht aus.")
            cur.execute("INSERT INTO music_votes (cycle_id, suggestion_id, member_id, points) VALUES (%s, %s, %s, %s) ON CONFLICT (cycle_id, suggestion_id, member_id) DO UPDATE SET points = EXCLUDED.points;", 
                        (cycle_id, vote.suggestion_id, vote.member_id, vote.points))
            conn.commit()
            return {"message": "Success", "budget_remaining": MAX_BUDGET - other_points - vote.points}


@app.get("/api/v1/music/admin/verify", dependencies=[Depends(require_admin)])
def verify_admin():
    return {"status": "ok"}


@app.post("/api/v1/music/admin/cycles", dependencies=[Depends(require_admin)])
def create_cycle(name: str):
    cleaned_name = name.strip()
    if not cleaned_name:
        raise HTTPException(status_code=400, detail="Name fehlt.")
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE music_cycles SET status = 'closed' WHERE status = 'active';")
            cur.execute(
                """
                INSERT INTO music_cycles (name, type, profile_id, starts_at, closes_at, status)
                VALUES (%s, 'weekly', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '7 days', 'active')
                RETURNING id;
                """,
                (cleaned_name,),
            )
            cycle_id = cur.fetchone()[0]
        conn.commit()
    return {"status": "success", "cycle_id": cycle_id}


@app.post(
    "/api/v1/music/admin/cycles/{cycle_id}/suggestions",
    dependencies=[Depends(require_admin)],
)
def create_moderator_suggestion(cycle_id: int, suggestion: SuggestionCreate):
    title = suggestion.title.strip()
    external_id = suggestion.external_id.strip()
    if not title or not external_id:
        raise HTTPException(status_code=400, detail="Songangaben fehlen.")
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO music_suggestions (
                    cycle_id, member_id, provider, external_id, title, channel_title, duration_ms
                )
                SELECT id, 'moderation', %s, %s, %s, %s, %s
                FROM music_cycles
                WHERE id = %s AND status = 'active'
                RETURNING id;
                """,
                (
                    suggestion.provider,
                    external_id,
                    title,
                    suggestion.channel_title,
                    suggestion.duration_ms,
                    cycle_id,
                ),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=409, detail="Dieser Voting-Zeitraum ist nicht aktiv.")
        conn.commit()
    return {"status": "success", "suggestion_id": row[0]}


@app.patch("/api/v1/music/admin/cycles/{cycle_id}", dependencies=[Depends(require_admin)])
def update_cycle(cycle_id: int, update: CycleUpdate):
    if update.status not in {None, "planned", "active", "closed"}:
        raise HTTPException(status_code=400, detail="Ungültiger Status.")
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE music_cycles
                SET name = COALESCE(%s, name),
                    status = COALESCE(%s, status),
                    closes_at = COALESCE(%s::timestamptz, closes_at),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s;
                """,
                (update.name, update.status, update.closes_at, cycle_id),
            )
        conn.commit()
    return {"status": "success"}


@app.delete("/api/v1/music/admin/suggestions/{suggestion_id}", dependencies=[Depends(require_admin)])
def delete_suggestion(suggestion_id: int):
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM music_suggestions WHERE id = %s;", (suggestion_id,))
        conn.commit()
    return {"status": "success"}


@app.get("/api/v1/music/admin/all-votes", dependencies=[Depends(require_admin)])
def get_all_votes():
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT v.member_id, s.title, v.points, v.created_at
                FROM music_votes v
                JOIN music_suggestions s ON s.id = v.suggestion_id
                ORDER BY v.created_at DESC
                LIMIT 500;
                """
            )
            return {"votes": cur.fetchall()}
