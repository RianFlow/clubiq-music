"""Isolated compact app hosting; generated files are staged before a release."""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

router = APIRouter()
APP_FILES = {"index.html", "app.js", "app.css", "crest.webp", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"}
APP_DIRECTORY = Path(__file__).resolve().parent / "static" / "barver-app"


@router.get("/app", include_in_schema=False)
def compact_app_redirect():
    return RedirectResponse("/app/", status_code=307)


@router.get("/app/", include_in_schema=False)
@router.get("/app/{filename}", include_in_schema=False)
def compact_app_file(filename: str = "index.html"):
    if filename not in APP_FILES or not (APP_DIRECTORY / filename).is_file():
        raise HTTPException(status_code=404, detail="Web-App noch nicht bereitgestellt.")
    media_type = "application/manifest+json" if filename.endswith(".webmanifest") else "text/javascript" if filename.endswith(".js") else None
    return FileResponse(APP_DIRECTORY / filename, media_type=media_type, headers={
        "Cache-Control": "private, no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Cloudflare-CDN-Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })
