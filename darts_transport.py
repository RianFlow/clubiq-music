"""Optional egress for the exact public 3K hosts; unrelated services stay untouched."""
from __future__ import annotations

import os
import ssl
from urllib.parse import unquote, urlsplit

import requests

PUBLIC_HOSTS = frozenset({"backend-ddv.3k-darts.com", "backend4.3k-darts.com", "live.3k-darts.com"})


def _configured_proxy(url, scheme):
    try:
        target = urlsplit(url)
        allowed = (target.scheme == scheme and target.hostname in PUBLIC_HOSTS
                   and target.port in (None, 443) and target.username is None and target.password is None)
    except (TypeError, ValueError):
        allowed = False
    value = os.getenv("DARTS_3K_HTTPS_PROXY", "").strip()
    if not allowed or not value:
        return None
    try:
        proxy = urlsplit(value)
        valid = (proxy.scheme in {"http", "https"} and bool(proxy.hostname)
                 and proxy.port != 0 and proxy.path in {"", "/"} and not proxy.query and not proxy.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Ungültige 3K-Proxy-Konfiguration.") from None
    return value, proxy


def scoped_get(request, url, **kwargs):
    """Keep existing Requests callers/mock seams and never follow a proxy redirect."""
    configured = _configured_proxy(url, "https")
    if configured is None:
        return request(url, **kwargs)
    value, _ = configured
    options = {**kwargs, "proxies": {**(kwargs.get("proxies") or {}), "https": value}, "allow_redirects": False}
    options["verify"] = kwargs.get("verify", True)
    if not options["verify"]:
        raise ValueError("Die 3K-Verbindung benötigt eine TLS-Prüfung.")
    try:
        response = request(url, **options)
    except requests.RequestException as error:
        # Underlying proxy errors can embed user:password. Preserve normal error
        # classes for retry logic, while exposing only a fixed diagnostic message.
        raise type(error)("3K-Quellverbindung ist gerade nicht erreichbar.") from None
    if 300 <= response.status_code < 400:
        raise requests.HTTPError("Unerwartete Weiterleitung der 3K-Quelle.", response=response)
    return response


def websocket_options(url):
    """Explicit websocket-client HTTP CONNECT settings, with verified target TLS."""
    configured = _configured_proxy(url, "wss")
    if configured is None:
        return {}
    _, proxy = configured
    # websocket-client supports HTTP CONNECT, but not TLS to an HTTPS proxy.
    # An unsupported proxy raises safely; the existing HTTPS REST fallback stays active.
    if proxy.scheme != "http":
        raise ValueError("Für 3K-WebSockets ist ein HTTP-CONNECT-Proxy erforderlich.")
    options = {"http_proxy_host": proxy.hostname, "http_proxy_port": proxy.port or 80,
               "proxy_type": "http", "http_proxy_timeout": 10,
               # An empty list would inherit global NO_PROXY from websocket-client.
               "http_no_proxy": [""], "redirect_limit": 0,
               "sslopt": {"cert_reqs": ssl.CERT_REQUIRED, "check_hostname": True}}
    if proxy.username is not None:
        options["http_proxy_auth"] = (unquote(proxy.username), unquote(proxy.password or ""))
    return options
