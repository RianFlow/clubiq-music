"""Real HTTP and PostgreSQL in a disposable schema; never alter existing club data."""
import hashlib
import os
from pathlib import Path
import socket
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg
from psycopg import sql
import requests
import uvicorn
from fastapi import FastAPI

from db_config import connection_kwargs
from darts_cms import CMS_SCHEMA_SQL, create_router


@unittest.skipUnless(os.getenv("CMS_TEST_POSTGRES") == "1", "isolated PostgreSQL required")
class CmsPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = "cms_test_" + uuid4().hex
        with psycopg.connect(**connection_kwargs()) as conn, conn.cursor() as cur:
            cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
            cur.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(cls.schema)))
            cur.execute(CMS_SCHEMA_SQL)
            cur.execute(CMS_SCHEMA_SQL)
        def connect():
            return psycopg.connect(**connection_kwargs(), options=f"-c search_path={cls.schema}")
        cls.connect = staticmethod(connect)
        def image(data):
            from main import _validated_player_image
            return _validated_player_image(data)
        app = FastAPI()
        app.include_router(create_router(connect, lambda user, pwd: user == "owner" and pwd == "owner-test-password",
                                         lambda: hashlib.sha256(b"owner-test-password").hexdigest(), image, lambda: "owner"))
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        cls.origin = f"http://127.0.0.1:{sock.getsockname()[1]}"
        cls.server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        cls.thread = threading.Thread(target=cls.server.run, kwargs={"sockets": [sock]}, daemon=True)
        cls.thread.start()
        for _ in range(200):
            if cls.server.started:
                break
            time.sleep(.01)
        if not cls.server.started:
            raise RuntimeError("Local CMS test server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=10)
        with psycopg.connect(**connection_kwargs()) as conn, conn.cursor() as cur:
            cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(cls.schema)))

    def setUp(self):
        self.prefix = ""
        self.owner = requests.Session()
        self.owner.headers["X-CMS-Request"] = "1"
        result = self.owner.post(self.origin + "/api/v1/cms/login", json={"username": "owner", "password": "owner-test-password"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIn("HttpOnly", result.headers["set-cookie"])
        self.assertIn("SameSite=strict", result.headers["set-cookie"])
        self.club = self.call("POST", "/clubs", {"slug": "test-" + uuid4().hex[:12], "name": "Testverein"}).json()
        self.prefix = f"/clubs/{self.club['id']}"

    def call(self, method, path, body=None, client=None, expected=200, **kwargs):
        result = (client or self.owner).request(method, self.origin + "/api/v1/cms" + path, json=body, timeout=10, **kwargs)
        if method == "POST" and path in ("/clubs", self.prefix + "/posts", self.prefix + "/users") and expected == 200:
            expected = 201
        self.assertEqual(result.status_code, expected, result.text)
        return result

    def make_public(self):
        self.club = self.call("PUT", self.prefix, {"version": self.club["version"], "name": self.club["name"], "published": True}).json()

    def post(self, title="Erste Fassung", image_id=None):
        return self.call("POST", self.prefix + "/posts", {"title": title, "summary": "Kurze Nachricht", "body": "Absatz eins.\n\nAbsatz zwei.", "image_id": image_id}).json()

    def test_drafts_publish_snapshots_conflicts_history_and_restore(self):
        self.make_public()
        post = self.post()
        public = f"/sites/{self.club['slug']}/posts"
        self.assertEqual(self.call("GET", public).json()["posts"], [])
        post = self.call("POST", self.prefix + f"/posts/{post['id']}/publish", {"version": post["version"]}).json()
        self.assertEqual(self.call("GET", public).json()["posts"][0]["title"], "Erste Fassung")
        old_version = post["version"]
        post = self.call("PUT", self.prefix + f"/posts/{post['id']}", {"version": old_version, "title": "Neuer Entwurf", "body": "Noch privat"}).json()
        self.assertEqual(self.call("GET", public).json()["posts"][0]["title"], "Erste Fassung")
        self.call("PUT", self.prefix + f"/posts/{post['id']}", {"version": old_version, "title": "Veraltet", "body": "Nicht überschreiben"}, expected=409)
        history = self.call("GET", self.prefix + f"/posts/{post['id']}/revisions").json()["revisions"]
        self.assertEqual(len(history), 3)
        restored = self.call("POST", self.prefix + f"/posts/{post['id']}/restore", {"version": post["version"], "revision": 1}).json()
        self.assertEqual(restored["draft"]["title"], "Erste Fassung")
        self.assertEqual(restored["published"]["title"], "Erste Fassung")
        self.call("POST", self.prefix + f"/posts/{post['id']}/unpublish", {"version": restored["version"]})
        self.assertEqual(self.call("GET", public).json()["posts"], [])
        self.call("GET", public + f"/{post['id']}", expected=404)

    def test_schedule_and_expiry_require_no_running_pc_or_publish_job(self):
        self.make_public()
        post = self.post()
        post = self.call("POST", self.prefix + f"/posts/{post['id']}/publish", {"version": post["version"], "publish_at": (datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}).json()
        public = f"/sites/{self.club['slug']}/posts"
        self.assertEqual(self.call("GET", public).json()["posts"], [])
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute("UPDATE cms_posts SET publish_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=%s", (post["id"],))
        self.assertEqual(len(self.call("GET", public).json()["posts"]), 1)
        with self.connect() as conn, conn.cursor() as cur:
            cur.execute("UPDATE cms_posts SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=%s", (post["id"],))
        self.assertEqual(self.call("GET", public).json()["posts"], [])

    def test_editor_has_only_own_club_and_sessions_are_revoked(self):
        username = "redaktion-" + uuid4().hex[:12]
        editor = self.call("POST", self.prefix + "/users", {"username": username, "password": "redaktion-test-password"}).json()
        client = requests.Session();client.headers["X-CMS-Request"] = "1"
        self.call("POST", "/login", {"username": username, "password": "redaktion-test-password"}, client=client)
        clubs = self.call("GET", "/clubs", client=client).json()["clubs"]
        self.assertEqual([club["id"] for club in clubs], [self.club["id"]])
        self.call("POST", self.prefix + "/posts", {"title": "Redaktion", "body": "Eigener Verein"}, client=client, expected=201)
        self.call("GET", "/clubs/1/posts", client=client, expected=404)
        self.call("POST", "/clubs", {"slug": "fremd", "name": "Fremder Verein"}, client=client, expected=403)
        self.call("GET", self.prefix + "/users", client=client, expected=403)
        self.call("PUT", self.prefix, {"version": 1, "name": "Testverein", "published": True}, client=client, expected=403)
        self.call("POST", self.prefix + "/users", {"username": "owner", "password": "anderes-test-password"}, expected=409)
        self.call("PUT", self.prefix + f"/users/{editor['id']}", {"active": False})
        self.call("GET", "/session", client=client, expected=401)
        self.call("POST", "/login", {"username": username, "password": "redaktion-test-password"}, client=client, expected=401)

    def test_media_are_private_until_published_and_cannot_cross_clubs(self):
        data = (Path(__file__).resolve().parents[1] / "pics/logo.png").read_bytes()
        result = self.owner.post(self.origin + "/api/v1/cms" + self.prefix + "/media", files={"image": ("logo.png", data, "image/png")})
        self.assertEqual(result.status_code, 201, result.text)
        image_id = result.json()["id"]
        self.make_public()
        public = f"/sites/{self.club['slug']}/media/{image_id}"
        self.call("GET", public, expected=404)
        self.call("GET", self.prefix + f"/media/{image_id}")
        post = self.post(image_id=image_id)
        self.call("POST", self.prefix + f"/posts/{post['id']}/publish", {"version": post["version"]})
        self.assertEqual(self.call("GET", public).content, data)
        second = self.call("POST", "/clubs", {"slug": "second-"+uuid4().hex[:12], "name": "Zweiter Verein"}).json()
        self.call("POST", f"/clubs/{second['id']}/posts", {"title": "Fremdes Bild", "body": "Kein Zugriff", "image_id": image_id}, expected=422)
        self.call("GET", f"/sites/barver/media/{image_id}", expected=404)

    def test_private_cache_csrf_logout_and_public_document_guards(self):
        self.assertEqual(self.owner.get(self.origin + "/api/v1/cms/session").headers["Cache-Control"], "no-store")
        without_header = requests.Session();without_header.cookies.update(self.owner.cookies)
        self.call("POST", self.prefix + "/posts", {"title": "CSRF", "body": "Nicht zulässig"}, client=without_header, expected=403)
        result = requests.get(self.origin + "/vereine/" + self.club["slug"])
        self.assertEqual(result.status_code, 404)
        self.make_public()
        self.assertEqual(requests.get(self.origin + "/vereine/" + self.club["slug"]).status_code, 200)
        self.assertEqual(requests.get(self.origin + "/vereine/" + self.club["slug"] + "/beitraege/999999").status_code, 404)
        self.call("DELETE", "/session")
        self.call("GET", "/session", expected=401)
