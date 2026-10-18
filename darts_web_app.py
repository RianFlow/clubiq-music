"""The installed Web-App uses the responsive website, within its existing scope."""
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

router = APIRouter()
APP_FILES = {"index.html", "app.js", "app.css", "crest.webp", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"}
APP_DIRECTORY = Path(__file__).resolve().parent / "static" / "barver-app"
LIVE_DOCUMENT = Path(__file__).resolve().parent / "darts.html"
APP_WORKER = Path(__file__).resolve().parent / "static" / "darts-web-app-sw.js"
APP_HEADERS = {
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
}


def shared_document(document):
    if not document.is_file():
        raise HTTPException(status_code=404, detail="Web-App noch nicht bereitgestellt.")
    html = document.read_text(encoding="utf-8")
    # All content, data loaders and responsive styles come from the same source.
    html = re.sub(r'href="/darts(?=[?\"])', 'href="/app/', html)
    html = html.replace('href="/training', 'href="/app/training').replace('href="/turnier', 'href="/app/turnier')
    html = html.replace('href="/"', 'href="/app/"')
    return HTMLResponse(html, headers=APP_HEADERS)


@router.get("/app/live", include_in_schema=False)
def compact_app_live():
    # Keep the website's live view inside the installed Web-App's /app/ scope.
    return shared_document(LIVE_DOCUMENT)


@router.get("/app/training", include_in_schema=False)
@router.get("/app/turnier", include_in_schema=False)
def shared_tournament(request: Request):
    # Training and tournaments already share a document on the website.
    return shared_document(LIVE_DOCUMENT.parent / "turnier.html")


@router.get("/app/sw.js", include_in_schema=False)
def shared_app_worker():
    return FileResponse(APP_WORKER, media_type="text/javascript", headers=APP_HEADERS)


@router.get("/app", include_in_schema=False)
def compact_app_redirect(request: Request):
    return RedirectResponse("/app/" + ("?" + request.url.query if request.url.query else ""), status_code=307)


@router.get("/app/", include_in_schema=False)
@router.get("/app/{filename}", include_in_schema=False)
def compact_app_file(filename: str = "index.html"):
    if filename == "index.html":
        return shared_document(LIVE_DOCUMENT)
    if filename not in APP_FILES or not (APP_DIRECTORY / filename).is_file():
        raise HTTPException(status_code=404, detail="Web-App noch nicht bereitgestellt.")
    media_type = "application/manifest+json" if filename.endswith(".webmanifest") else "text/javascript" if filename.endswith(".js") else None
    return FileResponse(APP_DIRECTORY / filename, media_type=media_type, headers={
        "Cache-Control": "private, no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Cloudflare-CDN-Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })
