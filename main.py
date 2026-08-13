from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import psycopg
import os
from dotenv import load_dotenv
import requests
import subprocess
import threading
import time
import json
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
from apscheduler.schedulers.background import BackgroundScheduler

load_dotenv()

DB_NAME = os.getenv("DB_NAME", "music_voting_dev")
DB_USER = os.getenv("DB_USER", "clubiq_dev")
DB_PASSWORD = os.getenv("DB_PASSWORD", "devpassword")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
MAX_BUDGET = int(os.getenv("MAX_BUDGET", 10))
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")

conn_info = f"dbname={DB_NAME} user={DB_USER} password={DB_PASSWORD} host={DB_HOST} port={DB_PORT}"
current_mpv_process = None

def close_expired_cycles():
    try:
        with psycopg.connect(conn_info) as conn:
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
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

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

class PlayerCommand(BaseModel):
    action: str

class BluetoothConnect(BaseModel):
    mac_address: str

@app.get("/")
def read_root():
    return FileResponse("index.html")

@app.post("/api/v1/music/auth/login")
def member_login(login: MemberLogin):
    m_id = login.member_id.strip().lower().replace(" ", "_")
    d_name = login.display_name or login.member_id
    try:
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO club_members (member_id, display_name) VALUES (%s, %s) 
                               ON CONFLICT (member_id) DO UPDATE SET display_name = EXCLUDED.display_name 
                               RETURNING id, member_id, display_name;""", (m_id, d_name))
                row = cur.fetchone()
                conn.commit()
                return {"status": "success", "member": {"id": row[0], "member_id": row[1], "display_name": row[2]}}
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/v1/music/provider/search")
def search_tracks(q: str):
    try:
        url = "https://www.googleapis.com/youtube/v3/search"
        params = {"part": "snippet", "q": q, "type": "video", "maxResults": 5, "key": YOUTUBE_API_KEY}
        response = requests.get(url, params=params)
        items = response.json().get("items", [])
        return {"results": [{"external_id": i["id"]["videoId"], "title": i["snippet"]["title"], "channel_title": i["snippet"]["channelTitle"]} for i in items]}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/v1/music/cycles/{cycle_id}/suggestions")
def create_suggestion(cycle_id: int, suggestion: SuggestionCreate):
    with psycopg.connect(conn_info) as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO music_suggestions (cycle_id, member_id, external_id, title, channel_title) VALUES (%s, %s, %s, %s, %s)", 
                        (cycle_id, suggestion.member_id, suggestion.external_id, suggestion.title, suggestion.channel_title))
            conn.commit()
            return {"message": "Success"}

@app.get("/api/v1/music/cycles/{cycle_id}/playlist")
def get_playlist(cycle_id: int):
    with psycopg.connect(conn_info) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT s.id, s.title, s.channel_title, COALESCE(SUM(v.points), 0) FROM music_suggestions s LEFT JOIN music_votes v ON s.id = v.suggestion_id WHERE s.cycle_id = %s GROUP BY s.id ORDER BY SUM(v.points) DESC;", (cycle_id,))
            return {"playlist": [{"suggestion_id": r[0], "title": r[1], "channel_title": r[2], "total_points": r[3]} for r in cur.fetchall()]}

@app.post("/api/v1/music/cycles/{cycle_id}/votes")
def cast_vote(cycle_id: int, vote: VoteCreate):
    with psycopg.connect(conn_info) as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO music_votes (cycle_id, suggestion_id, member_id, points) VALUES (%s, %s, %s, %s) ON CONFLICT (cycle_id, suggestion_id, member_id) DO UPDATE SET points = EXCLUDED.points;", 
                        (cycle_id, vote.suggestion_id, vote.member_id, vote.points))
            conn.commit()
            return {"message": "Success"}

@app.post("/api/v1/music/admin/update")
def update_from_github():
    if os.name != 'nt':
        subprocess.run(["git", "pull"], check=True)
        threading.Thread(target=lambda: (time.sleep(1), os._exit(0))).start()
        return {"status": "success"}
    return {"status": "mock"}

@app.post("/api/v1/music/mod/player")
def control_player(cmd: PlayerCommand):
    global current_mpv_process
    if cmd.action == 'play':
        with psycopg.connect(conn_info) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT external_id FROM music_suggestions WHERE cycle_id = 1 ORDER BY id ASC LIMIT 1;")
                row = cur.fetchone()
                if row:
                    current_mpv_process = subprocess.Popen(["mpv", "--no-video", f"https://www.youtube.com/watch?v={row[0]}"])
                    return {"status": "playing"}
    elif cmd.action in ['stop', 'skip']:
        if current_mpv_process: current_mpv_process.terminate()
        return {"status": "stopped"}
    return {"status": "unknown"}