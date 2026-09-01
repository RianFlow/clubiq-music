"""Keyword search in Radio-Browser; saved stations work without this directory."""
from concurrent.futures import ThreadPoolExecutor
from ipaddress import ip_address
import os
import threading
import time
from urllib.parse import urlparse
from uuid import UUID

import requests


DEFAULT_BASE_URL = "https://de1.api.radio-browser.info"
HEADERS = {"User-Agent": "ClubIQ-Music/1.0 (+https://github.com/RianFlow/clubiq-music)"}
_cache = {}
_cache_lock = threading.Lock()


class DirectoryUnavailable(RuntimeError):
    pass


def public_url(value):
    """Directory entries must never introduce file URLs or local IP targets."""
    if not isinstance(value, str) or len(value) > 1000:
        return None
    try:
        parsed = urlparse(value.strip())
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            return None
        if "." not in host or host.endswith((".local", ".localhost", ".internal")):
            return None
        try:
            if not ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return value.strip()
    except ValueError:
        return None


def station_result(row):
    if not isinstance(row, dict) or row.get("lastcheckok") != 1:
        return None
    try:
        station_uuid = str(UUID(str(row.get("stationuuid", ""))))
    except ValueError:
        return None
    name = " ".join(str(row.get("name") or "").split())[:120]
    stream = public_url(row.get("url_resolved")) or public_url(row.get("url"))
    if len(name) < 2 or not stream:
        return None
    return {
        "station_uuid": station_uuid, "name": name, "stream_url": stream,
        "genre": str(row.get("tags") or "")[:80],
        "country": str(row.get("country") or row.get("countrycode") or "")[:80],
        "codec": str(row.get("codec") or "")[:20],
        "logo_url": public_url(row.get("favicon")),
    }


def directory_request(path, params=None):
    try:
        base_url = os.getenv("RADIO_BROWSER_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        response = requests.get(base_url + path, params=params, headers=HEADERS, timeout=(3, 7))
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list):
            raise ValueError("Invalid directory response")
        return rows
    except (requests.RequestException, ValueError) as exc:
        raise DirectoryUnavailable(
            "Die Sendersuche ist gerade nicht erreichbar. Internetverbindung am Raspberry prüfen "
            "und erneut suchen. Gespeicherte Sender bleiben verfügbar."
        ) from exc


def search_stations(query):
    query = " ".join(query.split())
    if not 2 <= len(query) <= 80:
        raise ValueError("Bitte 2 bis 80 Zeichen als Suchwort eingeben.")
    key = query.casefold()
    with _cache_lock:
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return [dict(row) for row in cached[1]]
    params = {"limit": 20, "hidebroken": "true", "order": "clickcount", "reverse": "true"}
    results = []
    failures = []
    # A keyword can be a station name OR a genre, not an AND-filter of both.
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(directory_request, "/json/stations/search", {**params, field: query})
                for field in ("name", "tag")]
        for job in jobs:
            try:
                results.extend(job.result())
            except DirectoryUnavailable as exc:
                failures.append(exc)
    if len(failures) == 2:
        raise failures[0]
    unique = {}
    for row in results:
        station = station_result(row)
        if station:
            # Name and genre queries frequently return the very same stream.
            unique.setdefault(station["stream_url"], station)
    stations = sorted(unique.values(), key=lambda item: (
        item["name"].casefold() != key, key not in item["name"].casefold(),
    ))[:24]
    if not failures:
        with _cache_lock:
            if len(_cache) >= 64:
                _cache.pop(next(iter(_cache)))
            _cache[key] = (time.monotonic(), stations)
    return [dict(row) for row in stations]


def get_station(station_uuid):
    station_uuid = str(UUID(str(station_uuid)))
    rows = directory_request("/json/stations/byuuid/" + station_uuid)
    station = next((item for row in rows if (item := station_result(row))
                    and item["station_uuid"] == station_uuid), None)
    if not station:
        raise ValueError("Dieser Sender ist nicht mehr verfügbar. Bitte erneut suchen.")
    return station
