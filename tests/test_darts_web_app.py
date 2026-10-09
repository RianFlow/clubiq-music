import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
import asyncio
from types import SimpleNamespace


class TestClient:
    def __init__(self, app): self.app = app
    def get(self, path, **kwargs): return self.request("GET", path)
    def post(self, path): return self.request("POST", path)
    def request(self, method, path):
        from urllib.parse import unquote
        messages = []
        async def receive(): return {"type": "http.request", "body": b"", "more_body": False}
        async def send(message): messages.append(message)
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http", "path": unquote(path), "raw_path": path.encode(), "query_string": b"", "root_path": "", "headers": [], "server": ("test", 80), "client": ("test", 123)}
        asyncio.run(self.app(scope, receive, send))
        start = next(m for m in messages if m["type"] == "http.response.start")
        return SimpleNamespace(status_code=start["status"], headers={k.decode(): v.decode() for k, v in start["headers"]})
import darts_web_app
from darts_push import barver_push_event, push_payload
import json


class CompactWebAppTests(unittest.TestCase):
    def test_live_view_stays_in_app_scope_without_arbitrary_files(self):
        app = FastAPI()
        app.include_router(darts_web_app.router)
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory, 'darts.html')
            page.write_text('<html>Live</html>', encoding='utf8')
            with patch.object(darts_web_app, 'LIVE_DOCUMENT', page):
                client = TestClient(app)
                response = client.get('/app/live')
                self.assertEqual(response.status_code, 200)
                self.assertIn('no-store', response.headers['cache-control'])
                self.assertEqual(client.get('/app/live/main.py').status_code, 404)
                self.assertEqual(client.post('/app/live').status_code, 405)

    def test_scoped_files_manifest_headers_and_missing_build(self):
        app = FastAPI()
        app.include_router(darts_web_app.router)
        with tempfile.TemporaryDirectory() as directory, patch.object(darts_web_app, 'APP_DIRECTORY', Path(directory)):
            client = TestClient(app)
            self.assertEqual(client.get('/app/').status_code, 404)
            Path(directory, 'index.html').write_text('<html>App</html>', encoding='utf8')
            Path(directory, 'sw.js').write_text('// worker', encoding='utf8')
            Path(directory, 'manifest.webmanifest').write_text('{}', encoding='utf8')
            self.assertEqual(client.get('/app', follow_redirects=False).headers['location'], '/app/')
            self.assertEqual(client.get('/app/').status_code, 200)
            self.assertIn('no-store', client.get('/app/sw.js').headers['cache-control'])
            self.assertEqual(client.get('/app/sw.js').headers['cloudflare-cdn-cache-control'], 'no-store')
            self.assertIn('javascript', client.get('/app/sw.js').headers['content-type'])
            self.assertIn('application/manifest+json', client.get('/app/manifest.webmanifest').headers['content-type'])
            self.assertEqual(client.get('/app/unknown').status_code, 404)
            self.assertEqual(client.get('/app/%2e%2e%2fmain.py').status_code, 404)
            self.assertEqual(client.post('/app/').status_code, 405)

    def test_push_payload_links_to_match_without_exposing_subscription(self):
        event = barver_push_event('live', {'type':'player_start','matchId':12,'gameId':'test-game','playerSide':'home','team':'SV Barver Darts A','player':'Test Spieler'})
        payload = json.loads(push_payload(event))
        self.assertEqual(payload['matchId'], 12)
        self.assertEqual(payload['eventId'], event['event_id'])
        self.assertEqual(set(payload), {'title','body','url','tag','matchId','eventId'})
