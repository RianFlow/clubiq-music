"""Shared club CMS. Drafts, media and editor access are scoped to one club."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CMS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS cms_clubs (
    id BIGSERIAL PRIMARY KEY,
    slug VARCHAR(48) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    tagline VARCHAR(160) NOT NULL DEFAULT '',
    about TEXT NOT NULL DEFAULT '',
    contact VARCHAR(600) NOT NULL DEFAULT '',
    accent CHAR(7) NOT NULL DEFAULT '#176b56',
    logo_id UUID,
    published BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cms_users (
    id BIGSERIAL PRIMARY KEY,
    club_id BIGINT NOT NULL REFERENCES cms_clubs(id),
    username VARCHAR(60) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cms_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT REFERENCES cms_users(id) ON DELETE CASCADE,
    owner_fingerprint CHAR(64),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK ((user_id IS NULL) <> (owner_fingerprint IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_cms_sessions_expiry ON cms_sessions(expires_at);
CREATE TABLE IF NOT EXISTS cms_media (
    id UUID PRIMARY KEY,
    club_id BIGINT NOT NULL REFERENCES cms_clubs(id),
    name VARCHAR(100) NOT NULL,
    media_type VARCHAR(32) NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cms_media_club ON cms_media(club_id, created_at DESC);
CREATE TABLE IF NOT EXISTS cms_posts (
    id BIGSERIAL PRIMARY KEY,
    club_id BIGINT NOT NULL REFERENCES cms_clubs(id),
    draft JSONB NOT NULL,
    published JSONB,
    publish_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    published_version INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cms_posts_club ON cms_posts(club_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS cms_post_revisions (
    post_id BIGINT NOT NULL REFERENCES cms_posts(id),
    version INTEGER NOT NULL,
    draft JSONB NOT NULL,
    action VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, version)
);
INSERT INTO cms_clubs(slug,name,tagline,published)
VALUES ('barver','SV Barver Darts','Vier Mannschaften. Ein Verein.',TRUE)
ON CONFLICT(slug) DO NOTHING;
"""

COOKIE = "clubiq_cms_session"
ROOT = Path(__file__).resolve().parent
VISIBLE = "published IS NOT NULL AND publish_at<=CURRENT_TIMESTAMP AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)"
CLUB_COLUMNS = "id,slug,name,tagline,about,contact,accent,logo_id,published,version"
POST_COLUMNS = "id,club_id,draft,published,publish_at,expires_at,version,published_version,updated_at"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Login(StrictModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=256)


class ClubFields(StrictModel):
    name: str = Field(min_length=2, max_length=100)
    tagline: str = Field(default="", max_length=160)
    about: str = Field(default="", max_length=5000)
    contact: str = Field(default="", max_length=600)
    accent: str = Field(default="#176b56", pattern=r"^#[0-9a-fA-F]{6}$")
    logo_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
    published: bool = False


class ClubCreate(ClubFields):
    slug: str = Field(min_length=3, max_length=48, pattern=r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")


class ClubUpdate(ClubFields):
    version: int = Field(ge=1)


class PostContent(StrictModel):
    title: str = Field(min_length=2, max_length=140)
    summary: str = Field(default="", max_length=280)
    body: str = Field(min_length=2, max_length=20000)
    image_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")


class PostSave(PostContent):
    version: int = Field(default=0, ge=0)


class Version(StrictModel):
    version: int = Field(ge=1)


class Publish(Version):
    publish_at: datetime | None = None
    expires_at: datetime | None = None

    @field_validator("publish_at", "expires_at")
    @classmethod
    def aware(cls, value):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Der Zeitpunkt muss eine Zeitzone enthalten.")
        return value.astimezone(timezone.utc) if value else None

    @model_validator(mode="after")
    def ordered(self):
        if self.expires_at and self.expires_at <= (self.publish_at or datetime.now(timezone.utc)):
            raise ValueError("Das Ende muss nach dem Veröffentlichungsbeginn liegen.")
        return self


class Restore(Version):
    revision: int = Field(ge=1)


class Editor(StrictModel):
    username: str = Field(min_length=3, max_length=60, pattern=r"^[a-z0-9][a-z0-9._-]+$")
    password: str = Field(min_length=12, max_length=256)


class EditorUpdate(StrictModel):
    password: str | None = Field(default=None, min_length=12, max_length=256)
    active: bool = True


def password_hash(password):
    salt = secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600000).hex()
    return f"600000${salt}${derived}"


def password_matches(password, stored):
    try:
        iterations, salt, derived = stored.split("$")
        if int(iterations) != 600000 or len(salt) != 32 or len(derived) != 64:
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
        return hmac.compare_digest(candidate, derived)
    except (ValueError, AttributeError):
        return False


def club_payload(row):
    return dict(zip(("id", "slug", "name", "tagline", "about", "contact", "accent", "logoId", "published", "version"),
                    (*row[:7], str(row[7]) if row[7] else None, *row[8:])))


def post_payload(row):
    return {"id": row[0], "clubId": row[1], "draft": row[2], "published": row[3],
            "publishAt": row[4].isoformat() if row[4] else None,
            "expiresAt": row[5].isoformat() if row[5] else None,
            "version": row[6], "publishedVersion": row[7], "updatedAt": row[8].isoformat()}


def public_post(row, slug):
    content = row[3]
    return {"id": row[0], "title": content["title"], "summary": content.get("summary", ""),
            "body": content["body"], "publishedAt": row[4].isoformat(),
            "image": f"/api/v1/cms/sites/{slug}/media/{content['image_id']}" if content.get("image_id") else None,
            "href": f"/vereine/{slug}/beitraege/{row[0]}"}


def create_router(connect, owner_credentials, owner_fingerprint, validate_image, owner_username=lambda: ""):
    router = APIRouter()
    attempts = {}
    attempts_lock = Lock()
    dummy_hash = password_hash(secrets.token_hex(32))

    def private(response: Response):
        response.headers["Cache-Control"] = "no-store"

    def subject(request: Request, response: Response):
        private(response)
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("X-CMS-Request") != "1":
            raise HTTPException(403, "Bitte die Verwaltung erneut öffnen.", headers={"Cache-Control": "no-store"})
        token = request.cookies.get(COOKIE, "")
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            raise HTTPException(401, "Bitte anmelden.", headers={"Cache-Control": "no-store"})
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""SELECT s.user_id,s.owner_fingerprint,u.club_id,u.active,u.username
                           FROM cms_sessions s LEFT JOIN cms_users u ON u.id=s.user_id
                           WHERE s.token_hash=%s AND s.expires_at>CURRENT_TIMESTAMP""",
                        (hashlib.sha256(token.encode()).hexdigest(),))
            row = cur.fetchone()
        if row and row[0] is None and row[1] and hmac.compare_digest(row[1], owner_fingerprint()):
            return {"owner": True, "clubId": None, "username": "Administrator"}
        if row and row[0] is not None and row[3]:
            return {"owner": False, "clubId": row[2], "username": row[4]}
        raise HTTPException(401, "Die Anmeldung ist abgelaufen. Bitte erneut anmelden.", headers={"Cache-Control": "no-store"})

    def owner(user):
        if not user["owner"]:
            raise HTTPException(403, "Diese Funktion ist der Administration vorbehalten.")

    def club(cur, club_id, user=None, slug=None):
        if user and not user["owner"] and user["clubId"] != club_id:
            raise HTTPException(404, "Verein nicht gefunden.")
        cur.execute(f"SELECT {CLUB_COLUMNS} FROM cms_clubs WHERE " + ("slug=%s AND published=TRUE" if slug else "id=%s"), (slug or club_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Verein nicht gefunden.")
        return row

    def media(cur, club_id, media_id):
        if media_id:
            cur.execute("SELECT id FROM cms_media WHERE club_id=%s AND id=%s::uuid", (club_id, media_id))
            if not cur.fetchone():
                raise HTTPException(422, "Das Bild gehört nicht zu diesem Verein.")

    def locked_post(cur, club_id, post_id, version):
        cur.execute(f"SELECT {POST_COLUMNS} FROM cms_posts WHERE club_id=%s AND id=%s FOR UPDATE", (club_id, post_id))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Beitrag nicht gefunden.")
        if row[6] != version:
            raise HTTPException(409, "Der Beitrag wurde inzwischen geändert. Bitte neu laden; dein Text bleibt im Formular.")
        return row

    def revision(cur, post_id, version, draft, action):
        cur.execute("INSERT INTO cms_post_revisions(post_id,version,draft,action) VALUES (%s,%s,%s::jsonb,%s)",
                    (post_id, version, json.dumps(draft), action))

    @router.get("/cms", include_in_schema=False)
    def cms_document():
        return FileResponse(ROOT / "cms.html", headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"})

    @router.get("/vereine/{slug}", include_in_schema=False)
    @router.get("/vereine/{slug}/beitraege/{post_id}", include_in_schema=False)
    def club_document(slug: str, post_id: int | None = None):
        with connect() as conn, conn.cursor() as cur:
            row = club(cur, None, slug=slug)
            if post_id is not None:
                cur.execute(f"SELECT id FROM cms_posts WHERE club_id=%s AND id=%s AND {VISIBLE}", (row[0], post_id))
                if not cur.fetchone():
                    raise HTTPException(404, "Beitrag nicht gefunden.")
        return FileResponse(ROOT / "cms-site.html", headers={"Cache-Control": "no-store"})

    @router.post("/api/v1/cms/login")
    def login(body: Login, request: Request, response: Response):
        private(response)
        if request.headers.get("X-CMS-Request") != "1":
            raise HTTPException(403, "Bitte die Verwaltung öffnen.")
        key = (request.client.host if request.client else "unknown", body.username)
        now = time.monotonic()
        with attempts_lock:
            for entry in list(attempts):
                if now - attempts[entry][0] > 60:
                    del attempts[entry]
            started, count = attempts.get(key, (now, 0))
            if count >= 10 or len(attempts) > 512:
                raise HTTPException(429, "Bitte eine Minute warten und erneut versuchen.")
            attempts[key] = (started, count + 1)
        user_id, fingerprint = None, None
        with connect() as conn, conn.cursor() as cur:
            if owner_credentials(body.username, body.password):
                fingerprint = owner_fingerprint()
            else:
                cur.execute("SELECT id,password_hash,active FROM cms_users WHERE username=%s", (body.username,))
                row = cur.fetchone()
                valid_password = password_matches(body.password, row[1] if row else dummy_hash)
                if not row or not row[2] or not valid_password:
                    raise HTTPException(401, "Benutzername oder Passwort ungültig.")
                user_id = row[0]
            token = secrets.token_hex(32)
            cur.execute("DELETE FROM cms_sessions WHERE expires_at<=CURRENT_TIMESTAMP")
            cur.execute("INSERT INTO cms_sessions(token_hash,user_id,owner_fingerprint,expires_at) VALUES (%s,%s,%s,%s)",
                        (hashlib.sha256(token.encode()).hexdigest(), user_id, fingerprint, datetime.now(timezone.utc) + timedelta(hours=8)))
        with attempts_lock:
            attempts.pop(key, None)
        response.set_cookie(COOKIE, token, max_age=8 * 3600, httponly=True, samesite="strict",
                            secure=request.url.hostname not in ("localhost", "127.0.0.1", "testserver"), path="/api/v1/cms")
        return {"ok": True}

    @router.delete("/api/v1/cms/session")
    def logout(request: Request, response: Response):
        private(response)
        if request.headers.get("X-CMS-Request") != "1":
            raise HTTPException(403, "Bitte die Verwaltung öffnen.")
        token = request.cookies.get(COOKIE, "")
        if re.fullmatch(r"[a-f0-9]{64}", token):
            with connect() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM cms_sessions WHERE token_hash=%s", (hashlib.sha256(token.encode()).hexdigest(),))
        response.delete_cookie(COOKIE, path="/api/v1/cms")
        return {"ok": True}

    @router.get("/api/v1/cms/session")
    def session(user=Depends(subject)):
        return user

    @router.get("/api/v1/cms/clubs")
    def clubs(user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            cur.execute(f"SELECT {CLUB_COLUMNS} FROM cms_clubs" + ("" if user["owner"] else " WHERE id=%s") + " ORDER BY name,id",
                        () if user["owner"] else (user["clubId"],))
            return {"clubs": [club_payload(row) for row in cur.fetchall()]}

    @router.post("/api/v1/cms/clubs", status_code=201)
    def create_club(body: ClubCreate, user=Depends(subject)):
        owner(user)
        if body.logo_id:
            raise HTTPException(422, "Bitte den Verein zuerst anlegen und danach ein Logo auswählen.")
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute(f"""INSERT INTO cms_clubs(slug,name,tagline,about,contact,accent,published)
                                VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING {CLUB_COLUMNS}""",
                            (body.slug, body.name, body.tagline, body.about, body.contact, body.accent, body.published))
                return club_payload(cur.fetchone())
        except UniqueViolation:
            raise HTTPException(409, "Diese Vereinsadresse ist schon vergeben.") from None

    @router.put("/api/v1/cms/clubs/{club_id}")
    def save_club(club_id: int, body: ClubUpdate, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            current = club(cur, club_id, user)
            if not user["owner"] and body.published != current[8]:
                raise HTTPException(403, "Die öffentliche Vereinsseite wird von der Administration freigegeben.")
            media(cur, club_id, body.logo_id)
            cur.execute(f"""UPDATE cms_clubs SET name=%s,tagline=%s,about=%s,contact=%s,accent=%s,logo_id=%s::uuid,
                            published=%s,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=%s AND version=%s
                            RETURNING {CLUB_COLUMNS}""",
                        (body.name, body.tagline, body.about, body.contact, body.accent, body.logo_id, body.published, club_id, body.version))
            row = cur.fetchone()
            if not row:
                raise HTTPException(409, "Die Vereinsangaben wurden inzwischen geändert. Bitte neu laden.")
            return club_payload(row)

    @router.get("/api/v1/cms/clubs/{club_id}/posts")
    def posts(club_id: int, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            cur.execute(f"SELECT {POST_COLUMNS} FROM cms_posts WHERE club_id=%s ORDER BY updated_at DESC,id DESC LIMIT 200", (club_id,))
            return {"posts": [post_payload(row) for row in cur.fetchall()]}

    def save_post(club_id, post_id, body, user):
        draft = PostContent(**body.model_dump(exclude={"version"})).model_dump()
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            media(cur, club_id, body.image_id)
            if post_id is None:
                if body.version:
                    raise HTTPException(422, "Neue Beiträge haben noch keine Versionsnummer.")
                cur.execute(f"INSERT INTO cms_posts(club_id,draft) VALUES (%s,%s::jsonb) RETURNING {POST_COLUMNS}", (club_id, json.dumps(draft)))
            else:
                locked_post(cur, club_id, post_id, body.version)
                cur.execute(f"UPDATE cms_posts SET draft=%s::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE club_id=%s AND id=%s RETURNING {POST_COLUMNS}",
                            (json.dumps(draft), club_id, post_id))
            row = cur.fetchone()
            revision(cur, row[0], row[6], draft, "saved")
            return post_payload(row)

    @router.post("/api/v1/cms/clubs/{club_id}/posts", status_code=201)
    def create_post(club_id: int, body: PostSave, user=Depends(subject)):
        return save_post(club_id, None, body, user)

    @router.put("/api/v1/cms/clubs/{club_id}/posts/{post_id}")
    def update_post(club_id: int, post_id: int, body: PostSave, user=Depends(subject)):
        return save_post(club_id, post_id, body, user)

    @router.post("/api/v1/cms/clubs/{club_id}/posts/{post_id}/publish")
    def publish_post(club_id: int, post_id: int, body: Publish, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            row = locked_post(cur, club_id, post_id, body.version)
            PostContent(**row[2])
            media(cur, club_id, row[2].get("image_id"))
            cur.execute(f"""UPDATE cms_posts SET published=draft,publish_at=%s,expires_at=%s,version=version+1,
                            published_version=version+1,updated_at=CURRENT_TIMESTAMP WHERE club_id=%s AND id=%s RETURNING {POST_COLUMNS}""",
                        (body.publish_at or datetime.now(timezone.utc), body.expires_at, club_id, post_id))
            saved = cur.fetchone()
            revision(cur, post_id, saved[6], saved[2], "published")
            return post_payload(saved)

    @router.post("/api/v1/cms/clubs/{club_id}/posts/{post_id}/unpublish")
    def unpublish_post(club_id: int, post_id: int, body: Version, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            locked_post(cur, club_id, post_id, body.version)
            cur.execute(f"""UPDATE cms_posts SET published=NULL,publish_at=NULL,expires_at=NULL,published_version=NULL,
                            version=version+1,updated_at=CURRENT_TIMESTAMP WHERE club_id=%s AND id=%s RETURNING {POST_COLUMNS}""", (club_id, post_id))
            row = cur.fetchone()
            revision(cur, post_id, row[6], row[2], "unpublished")
            return post_payload(row)

    @router.get("/api/v1/cms/clubs/{club_id}/posts/{post_id}/revisions")
    def revisions(club_id: int, post_id: int, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            cur.execute("SELECT id FROM cms_posts WHERE club_id=%s AND id=%s", (club_id, post_id))
            if not cur.fetchone():
                raise HTTPException(404, "Beitrag nicht gefunden.")
            cur.execute("SELECT version,action,created_at FROM cms_post_revisions WHERE post_id=%s ORDER BY version DESC LIMIT 100", (post_id,))
            return {"revisions": [{"version": row[0], "action": row[1], "createdAt": row[2].isoformat()} for row in cur.fetchall()]}

    @router.post("/api/v1/cms/clubs/{club_id}/posts/{post_id}/restore")
    def restore_post(club_id: int, post_id: int, body: Restore, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            locked_post(cur, club_id, post_id, body.version)
            cur.execute("SELECT draft FROM cms_post_revisions WHERE post_id=%s AND version=%s", (post_id, body.revision))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Änderung nicht gefunden.")
            cur.execute(f"UPDATE cms_posts SET draft=%s::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE club_id=%s AND id=%s RETURNING {POST_COLUMNS}",
                        (json.dumps(row[0]), club_id, post_id))
            saved = cur.fetchone()
            revision(cur, post_id, saved[6], saved[2], "restored")
            return post_payload(saved)

    @router.get("/api/v1/cms/clubs/{club_id}/media")
    def media_list(club_id: int, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            cur.execute("SELECT id,name,media_type,octet_length(data) FROM cms_media WHERE club_id=%s ORDER BY created_at DESC LIMIT 200", (club_id,))
            return {"media": [{"id": str(row[0]), "name": row[1], "type": row[2], "bytes": row[3],
                               "preview": f"/api/v1/cms/clubs/{club_id}/media/{row[0]}"} for row in cur.fetchall()]}

    @router.post("/api/v1/cms/clubs/{club_id}/media", status_code=201)
    async def upload_media(club_id: int, image: UploadFile = File(...), user=Depends(subject)):
        data = await image.read(3 * 1024 * 1024 + 1)
        media_type, data = validate_image(data)
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            identifier = uuid4()
            name = Path((image.filename or "Vereinsbild").replace("\\", "/")).name[:100] or "Vereinsbild"
            cur.execute("INSERT INTO cms_media(id,club_id,name,media_type,data) VALUES (%s,%s,%s,%s,%s)", (identifier, club_id, name, media_type, data))
        return {"id": str(identifier), "name": name}

    @router.get("/api/v1/cms/clubs/{club_id}/media/{media_id}")
    def preview_media(club_id: int, media_id: UUID, user=Depends(subject)):
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            cur.execute("SELECT data,media_type FROM cms_media WHERE club_id=%s AND id=%s", (club_id, media_id))
            row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Bild nicht gefunden.")
        return Response(bytes(row[0]), media_type=row[1], headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @router.get("/api/v1/cms/clubs/{club_id}/users")
    def users(club_id: int, user=Depends(subject)):
        owner(user)
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            cur.execute("SELECT id,username,active FROM cms_users WHERE club_id=%s ORDER BY username", (club_id,))
            return {"users": [{"id": row[0], "username": row[1], "active": row[2]} for row in cur.fetchall()]}

    @router.post("/api/v1/cms/clubs/{club_id}/users", status_code=201)
    def create_user(club_id: int, body: Editor, user=Depends(subject)):
        owner(user)
        if body.username.casefold() == owner_username().casefold():
            raise HTTPException(409, "Dieser Benutzername ist schon vergeben.")
        try:
            with connect() as conn, conn.cursor() as cur:
                club(cur, club_id, user)
                cur.execute("INSERT INTO cms_users(club_id,username,password_hash) VALUES (%s,%s,%s) RETURNING id", (club_id, body.username, password_hash(body.password)))
                return {"id": cur.fetchone()[0]}
        except UniqueViolation:
            raise HTTPException(409, "Dieser Benutzername ist schon vergeben.") from None

    @router.put("/api/v1/cms/clubs/{club_id}/users/{user_id}")
    def save_user(club_id: int, user_id: int, body: EditorUpdate, user=Depends(subject)):
        owner(user)
        with connect() as conn, conn.cursor() as cur:
            club(cur, club_id, user)
            cur.execute("UPDATE cms_users SET active=%s,password_hash=COALESCE(%s,password_hash) WHERE club_id=%s AND id=%s RETURNING id",
                        (body.active, password_hash(body.password) if body.password else None, club_id, user_id))
            if not cur.fetchone():
                raise HTTPException(404, "Zugang nicht gefunden.")
            cur.execute("DELETE FROM cms_sessions WHERE user_id=%s", (user_id,))
        return {"ok": True}

    @router.get("/api/v1/cms/sites/{slug}")
    def site(slug: str, response: Response):
        private(response)
        with connect() as conn, conn.cursor() as cur:
            row = club(cur, None, slug=slug)
        value = club_payload(row)
        return {key: value[key] for key in ("slug", "name", "tagline", "about", "contact", "accent")} | {
            "logo": f"/api/v1/cms/sites/{slug}/media/{row[7]}" if row[7] else "/pics/sv-barver-darts-tight-512.webp" if slug == "barver" else None}

    @router.get("/api/v1/cms/sites/{slug}/posts")
    def site_posts(slug: str, response: Response, limit: int = Query(default=30, ge=1, le=100)):
        private(response)
        with connect() as conn, conn.cursor() as cur:
            row = club(cur, None, slug=slug)
            cur.execute(f"SELECT {POST_COLUMNS} FROM cms_posts WHERE club_id=%s AND {VISIBLE} ORDER BY publish_at DESC,id DESC LIMIT %s", (row[0], limit))
            return {"posts": [public_post(post, slug) for post in cur.fetchall()]}

    @router.get("/api/v1/cms/sites/{slug}/posts/{post_id}")
    def site_post(slug: str, post_id: int, response: Response):
        private(response)
        with connect() as conn, conn.cursor() as cur:
            row = club(cur, None, slug=slug)
            cur.execute(f"SELECT {POST_COLUMNS} FROM cms_posts WHERE club_id=%s AND id=%s AND {VISIBLE}", (row[0], post_id))
            post = cur.fetchone()
        if not post:
            raise HTTPException(404, "Beitrag nicht gefunden.")
        return public_post(post, slug)

    @router.get("/api/v1/cms/sites/{slug}/media/{media_id}")
    def site_media(slug: str, media_id: UUID):
        with connect() as conn, conn.cursor() as cur:
            row = club(cur, None, slug=slug)
            cur.execute(f"""SELECT data,media_type FROM cms_media WHERE club_id=%s AND id=%s AND
                            (id=%s OR EXISTS(SELECT 1 FROM cms_posts p WHERE p.club_id=%s AND {VISIBLE}
                            AND p.published->>'image_id'=%s))""", (row[0], media_id, row[7], row[0], str(media_id)))
            image = cur.fetchone()
        if not image:
            raise HTTPException(404, "Bild nicht gefunden.")
        return Response(bytes(image[0]), media_type=image[1], headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    return router
