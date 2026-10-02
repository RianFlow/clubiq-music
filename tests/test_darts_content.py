import asyncio
import json
import unittest
from datetime import datetime
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

import main


class _Cursor:
    def __init__(self, row=None):
        self.row = row
        self.sql = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, _params=None):
        self.sql.append(sql)

    def fetchone(self):
        return self.row

    def fetchall(self):
        return []


class _Connection:
    def __init__(self, cursor):
        self.cursor_obj = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.cursor_obj


class DartsContentTests(unittest.TestCase):
    def test_presence_is_ephemeral_upserts_and_returns_uncached_count(self):
        update = main.DartsPresenceUpdate(session_id="b34a89d7-11c4-4ae2-9d03-cf848508ae02")
        cursor = _Cursor(row=(2,))
        with patch.object(main, "db_connect", return_value=_Connection(cursor)):
            response = main.darts_presence(update)
        self.assertEqual(json.loads(response.body), {"online": 2, "windowSeconds": 120})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIn("expires_at<=CURRENT_TIMESTAMP", cursor.sql[0])
        self.assertIn("ON CONFLICT (session_id) DO UPDATE", cursor.sql[1])
        self.assertIn("120 seconds", cursor.sql[1])
        self.assertIn("expires_at>CURRENT_TIMESTAMP", cursor.sql[2])
        self.assertNotIn("ip_address", " ".join(cursor.sql))
        cursor = _Cursor(row=(1,))
        update.active = False
        with patch.object(main, "db_connect", return_value=_Connection(cursor)):
            main.darts_presence(update)
        self.assertIn("DELETE FROM darts_online_presence WHERE session_id=%s", cursor.sql[1])
        with self.assertRaises(ValidationError):
            main.DartsPresenceUpdate(session_id="not-a-uuid")

    def test_admin_crud_routes_require_admin_and_missing_password_denies(self):
        paths = {
            "/api/v1/darts/admin/events", "/api/v1/darts/admin/events/{event_id}",
            "/api/v1/darts/admin/events/{event_id}/image",
            "/api/v1/darts/admin/social-links", "/api/v1/darts/admin/social-links/{link_id}",
        }
        for route in main.app.routes:
            if getattr(route, "path", None) in paths:
                self.assertIn(main.require_admin, [dep.call for dep in route.dependant.dependencies])
        with patch.object(main, "ADMIN_PASSWORD", "secret"):
            with self.assertRaises(HTTPException) as caught:
                main.require_admin(None)
            self.assertEqual(caught.exception.status_code, 401)

    def test_event_https_timestamp_and_whitespace_validation(self):
        good = main.DartsEventUpdate(title="Open", website="https://example.org/event",
                                     starts_at=datetime.fromisoformat("2026-10-01T10:00:00+02:00"))
        parsed = main._validated_darts_event(good)
        self.assertEqual(parsed["starts_at"].utcoffset().total_seconds(), 0)
        for url in ("http://example.org", "https://user:pass@example.org", "https://example.org:bad"):
            with self.assertRaises(HTTPException):
                main._validated_darts_event(main.DartsEventUpdate(title="Open", website=url))
        with self.assertRaises(HTTPException):
            main._validated_darts_event(main.DartsEventUpdate(title="   "))
        with self.assertRaises(HTTPException):
            main._validated_darts_event(main.DartsEventUpdate(
                title="Open", starts_at=datetime(2026, 10, 1),
            ))
        with self.assertRaises(HTTPException):
            main._validated_social_link(main.DartsSocialLinkUpdate(
                platform="whatsapp", label="  ", website="https://example.org",
            ))

    def test_public_event_query_filters_active_and_current_window(self):
        cursor = _Cursor()
        with patch.object(main, "db_connect", return_value=_Connection(cursor)):
            self.assertEqual(main._darts_events(True), [])
            self.assertEqual(main._darts_events(False), [])
        public_sql, admin_sql = cursor.sql
        self.assertIn("active=TRUE", public_sql)
        self.assertIn("starts_at<=CURRENT_TIMESTAMP", public_sql)
        self.assertIn("ends_at>=CURRENT_TIMESTAMP", public_sql)
        self.assertNotIn("WHERE active=TRUE", admin_sql)

    def test_admin_can_preview_inactive_image_but_public_cannot(self):
        image_row = (b"\x89PNG\r\n\x1a\nimage", "image/png", 123, False)
        cursor = _Cursor(row=image_row)
        with patch.object(main, "db_connect", return_value=_Connection(cursor)):
            response = main.darts_admin_event_image_preview(9)
        self.assertEqual(response.body, image_row[0])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIn("WHERE id=%s;", cursor.sql[0])
        self.assertNotIn("active", cursor.sql[0])

        # The same row is hidden by the active/current predicates in the public
        # SELECT, so model PostgreSQL returning no match for that filtered query.
        public_cursor = _Cursor(row=None)
        with patch.object(main, "db_connect", return_value=_Connection(public_cursor)):
            with self.assertRaises(HTTPException) as caught:
                main.darts_event_image(9)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("active=TRUE", public_cursor.sql[0])

    def test_image_upload_rejects_more_than_three_mb_before_database_access(self):
        class Upload:
            async def read(self, _size):
                return b"x" * (3 * 1024 * 1024 + 1)

        with patch.object(main, "db_connect") as db:
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(main.darts_admin_upload_event_image(1, Upload()))
        self.assertEqual(caught.exception.status_code, 413)
        db.assert_not_called()


if __name__ == "__main__":
    unittest.main()
