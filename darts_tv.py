"""Upcoming, explicitly published SPORT1 darts streams; no inferred airtimes."""
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from threading import Lock
from urllib.parse import urljoin, urlsplit
import re
import requests

SOURCE = "https://www.sport1.de/tv-video/tv"
_cache = None
_retry_at = 0
_lock = Lock()


class _Streams(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items = []
        self.item = None
        self.heading = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and "sport1-newsticker-video-group__link" in attrs.get("class", "").split():
            self.item = {"url": attrs.get("href", ""), "title": "", "start": ""}
        elif self.item is not None and tag == "h3":
            self.heading = True
        elif self.item is not None and tag == "time":
            self.item["start"] = attrs.get("datetime", "")

    def handle_data(self, data):
        if self.item is not None and self.heading:
            self.item["title"] += data

    def handle_endtag(self, tag):
        if tag == "h3":
            self.heading = False
        elif tag == "a" and self.item is not None:
            self.items.append(self.item)
            self.item = None
            self.heading = False


def _parse(html):
    if "sport1-newsticker-video-group" not in html:
        raise ValueError("Unbekanntes Programmformat")
    parser = _Streams()
    parser.feed(html)
    result = {}
    for item in parser.items:
        title = " ".join(item["title"].split())
        if not re.match(r"^Darts\s+LIVE\s*:", title, re.I):
            continue
        url = urljoin(SOURCE, item["url"])
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "www.sport1.de" or not parts.path.startswith("/tv-video/stream/"):
            continue
        try:
            start = datetime.fromisoformat(item["start"].replace("Z", "+00:00"))
            if start.tzinfo is None:
                continue
        except ValueError:
            continue
        title = re.sub(r"^Darts\s+LIVE\s*:\s*", "", title, flags=re.I)[:180]
        key = (start.isoformat(), title)
        result[key] = {"title": title, "start": start.isoformat(), "provider": "SPORT1",
                       "kind": "Livestream", "url": url, "sourceUrl": SOURCE}
    return sorted(result.values(), key=lambda item: datetime.fromisoformat(item["start"]))


def _load():
    # Fixed public source, bounded body, no arbitrary URL fetching or media downloads.
    with requests.get(SOURCE, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"},
                      timeout=(3, 10), stream=True, allow_redirects=False) as response:
        response.raise_for_status()
        if response.status_code != 200:
            raise ValueError("Unerwartete Programmantwort")
        chunks, size = [], 0
        for chunk in response.iter_content(65536):
            size += len(chunk)
            if size > 2 * 1024 * 1024:
                raise ValueError("Programmantwort zu gross")
            chunks.append(chunk)
        return _parse(b"".join(chunks).decode("utf-8"))


def get_darts_tv(now=None):
    global _cache, _retry_at
    now = now or datetime.now(timezone.utc)
    with _lock:
        failed = False
        if (not _cache or now.timestamp() - _cache[0] >= 1800) and now.timestamp() >= _retry_at:
            try:
                _cache = (now.timestamp(), _load())
                _retry_at = 0
            except (requests.RequestException, ValueError, UnicodeError):
                failed = True
                _retry_at = now.timestamp() + 300
        usable = _cache is not None and now.timestamp() - _cache[0] < 86400
        stale = failed or now.timestamp() < _retry_at
        # Re-filter even a cached snapshot so past starts disappear without an upstream refresh.
        events = [item for item in _cache[1] if now < datetime.fromisoformat(item["start"]) <= now + timedelta(days=60)][:12] if usable else []
        return {"available": usable, "stale": stale, "sourceUrl": SOURCE,
                "updatedAt": datetime.fromtimestamp(_cache[0], timezone.utc).isoformat() if usable else None,
                "events": events}
