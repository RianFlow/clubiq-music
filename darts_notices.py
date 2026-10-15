"""Editable, expiring notices attached to stable game or appointment identifiers."""
from datetime import date, datetime, timezone
import re

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field


NOTICE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS darts_appointment_notices (
    target VARCHAR(80) PRIMARY KEY,
    title VARCHAR(240) NOT NULL,
    message VARCHAR(240) NOT NULL CHECK (length(trim(message)) > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class NoticeUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    message: str = Field(min_length=1, max_length=240)
    expires_at: datetime
    active: bool = True


def validate_target(target):
    if re.fullmatch(r"(?:match|event)-[1-9][0-9]{0,18}", target):
        return target
    if re.fullmatch(r"training-\d{4}-\d{2}-\d{2}", target):
        try:
            date.fromisoformat(target[9:])
            return target
        except ValueError:
            pass
    raise HTTPException(422, "Bitte ein Spiel oder einen Termin auswählen.")


def validated_notice(update):
    title = " ".join(update.title.split())
    message = " ".join(update.message.split())
    if not title or not message or any(ord(c) < 32 for c in title + message):
        raise HTTPException(422, "Bitte einen Hinweistext eingeben.")
    if update.expires_at.utcoffset() is None:
        raise HTTPException(422, "Das Ablaufdatum benötigt eine Zeitzone.")
    return title, message, update.expires_at.astimezone(timezone.utc), update.active


def create_router(connect, require_admin):
    router = APIRouter()
    public = "/api/v1/darts/appointment-notices"
    admin = "/api/v1/darts/admin/appointment-notices"

    def notices(public_only):
        where = " WHERE active AND expires_at > CURRENT_TIMESTAMP" if public_only else ""
        with connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT target,title,message,expires_at,active FROM darts_appointment_notices" + where + " ORDER BY expires_at,target")
            rows = cur.fetchall()
        return {"notices": [dict(target=r[0], message=r[2], expiresAt=r[3],
                                 **({} if public_only else {"title": r[1], "active": r[4]})) for r in rows]}

    @router.get(public)
    def published(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return notices(True)

    @router.get(admin, dependencies=[Depends(require_admin)])
    def listing(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return notices(False)

    @router.put(admin + "/{target}", dependencies=[Depends(require_admin)])
    def save(target: str, update: NoticeUpdate, response: Response):
        validate_target(target)
        values = validated_notice(update)
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""INSERT INTO darts_appointment_notices(target,title,message,expires_at,active)
                VALUES (%s,%s,%s,%s,%s) ON CONFLICT(target) DO UPDATE SET
                title=EXCLUDED.title,message=EXCLUDED.message,expires_at=EXCLUDED.expires_at,
                active=EXCLUDED.active,updated_at=CURRENT_TIMESTAMP""", (target, *values))
            conn.commit()
        response.headers["Cache-Control"] = "no-store"
        return {"status": "success"}

    @router.delete(admin + "/{target}", dependencies=[Depends(require_admin)])
    def remove(target: str, response: Response):
        validate_target(target)
        with connect() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM darts_appointment_notices WHERE target=%s", (target,))
            conn.commit()
        response.headers["Cache-Control"] = "no-store"
        return {"status": "success"}

    return router
