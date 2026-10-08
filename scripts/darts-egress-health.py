"""Probe the private CONNECT proxy without logging addresses or source payloads."""
import json
import http.client
import ssl
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

STATE = Path("/state")
TRACE = "https://www.cloudflare.com/cdn-cgi/trace"
SOURCE = "https://backend4.3k-darts.com/2k-backend4/api/v1/frontend/event/32751"


def read_url(url):
    # Explicit CONNECT avoids any NO_PROXY/environment-driven direct fallback.
    target = urlsplit(url)
    connection = http.client.HTTPSConnection("127.0.0.1", 40001, timeout=10,
                                              context=ssl.create_default_context())
    connection.set_tunnel(target.hostname, 443)
    try:
        headers = {"Accept": "application/json,text/plain", "Cache-Control": "no-cache", "User-Agent": "Mozilla/5.0"}
        if target.hostname == "backend4.3k-darts.com":
            headers.update(Origin="https://portal.3k-darts.com", Referer="https://portal.3k-darts.com/")
        connection.request("GET", target.path, headers=headers)
        response = connection.getresponse()
        if response.status != 200:
            raise HTTPError(url, response.status, "Unexpected status", response.headers, None)
        body = response.read(262145)
        if len(body) > 262144:
            raise ValueError("Response limit")
        return body
    finally:
        connection.close()


def probe():
    """Return (healthy, safe error code, recovery permitted). Never expose exceptions."""
    try:
        trace = read_url(TRACE).decode("utf-8")
        fields = dict(line.split("=", 1) for line in trace.splitlines() if "=" in line)
        if fields.get("warp") not in ("on", "plus"):
            return False, "warp-not-active", True
        event = json.loads(read_url(SOURCE)).get("event") or {}
        if event.get("id") != 32751 or event.get("dbId") != 5:
            return False, "unexpected-source", False
        return True, "", True
    except HTTPError as exc:
        # Access restrictions and rate limits require attention, not reconnection loops.
        code = exc.code
        exc.close()
        return False, "http-" + str(code), code >= 500
    except (ssl.SSLCertVerificationError, ValueError, TypeError, AttributeError):
        return False, "invalid-response", False
    except URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            return False, "certificate-error", False
        return False, "connection-error", True
    except (OSError, TimeoutError, http.client.HTTPException):
        return False, "connection-error", True


def cached_health(state=STATE, now=None):
    try:
        status = json.loads((state / "health.json").read_text())
        age = (time.time() if now is None else now) - status["checkedAt"]
        return status.get("healthy") is True and 0 <= age < 120
    except (OSError, ValueError, KeyError, TypeError):
        return False


if __name__ == "__main__":
    sys.exit(0 if (cached_health() if "--cached" in sys.argv else probe()[0]) else 1)
