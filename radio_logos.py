"""Bounded, cached radio artwork downloads; never connect to private networks."""
import http.client
from ipaddress import ip_address
import socket
import ssl
import threading
import time
from urllib.parse import quote, urljoin, urlsplit


MAX_BYTES = 1024 * 1024
CACHE_SECONDS = 6 * 60 * 60
FAILURE_SECONDS = 5 * 60
_cache = {}
_cache_lock = threading.Lock()


def public_target(url):
    if not isinstance(url, str) or len(url) > 1000 or any(ord(c) < 32 for c in url):
        raise ValueError("Invalid logo URL")
    parsed = urlsplit(url)
    host = (parsed.hostname or "").rstrip(".").encode("idna").decode("ascii")
    if (parsed.scheme not in {"http", "https"} or not host or parsed.username
            or parsed.password or parsed.port not in (None, 80, 443)):
        raise ValueError("Invalid logo URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("Private logo target")
    # Connect to the validated numeric address, not to a second DNS lookup.
    addresses.sort(key=lambda item: item[0] != socket.AF_INET)
    return parsed, host, port, addresses[0][4][0]


def image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    return None


def download_logo(url):
    deadline = time.monotonic() + 10
    for _ in range(4):
        parsed, host, port, address = public_target(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Logo download timed out")
        connection = http.client.HTTPConnection(host, port, timeout=min(3, remaining))
        try:
            connection.sock = socket.create_connection((address, port), timeout=min(3, remaining))
            if parsed.scheme == "https":
                connection.sock = ssl.create_default_context().wrap_socket(connection.sock, server_hostname=host)
            connection.sock.settimeout(max(.01, deadline - time.monotonic()))
            path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
            if parsed.query:
                path += "?" + quote(parsed.query, safe="%=&?/:@!$'()*+,;~-._")
            connection.request("GET", path, headers={
                "User-Agent": "ClubIQ-Music/1.0 (+https://github.com/RianFlow/clubiq-music)",
                "Accept": "image/png,image/jpeg,image/webp,image/gif,image/x-icon",
                "Accept-Encoding": "identity",
            })
            transport = connection.sock
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    return None
                url = urljoin(url, location)
                continue  # Every redirect is resolved and validated again.
            if response.status != 200:
                return None
            content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            if content_type not in {"image/png", "image/jpeg", "image/gif", "image/webp",
                                    "image/x-icon", "image/vnd.microsoft.icon"}:
                return None
            if int(response.getheader("Content-Length") or 0) > MAX_BYTES:
                return None
            data = bytearray()
            while len(data) <= MAX_BYTES and not response.isclosed():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Logo download timed out")
                transport.settimeout(remaining)
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            detected = image_type(data)
            expected = "image/x-icon" if content_type == "image/vnd.microsoft.icon" else content_type
            if len(data) <= MAX_BYTES and detected == expected:
                return bytes(data), detected
            return None
        finally:
            connection.close()
    return None


def cached_logo(url):
    if not url:
        return None
    with _cache_lock:
        cached = _cache.get(url)
        if cached and cached[0] > time.monotonic():
            return cached[1]
    try:
        result = download_logo(url)
    except (OSError, ValueError, http.client.HTTPException):
        result = None
    with _cache_lock:
        if len(_cache) >= 64:
            _cache.pop(next(iter(_cache)))
        _cache[url] = (time.monotonic() + (CACHE_SECONDS if result else FAILURE_SECONDS), result)
    return result
