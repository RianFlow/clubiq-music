import asyncio
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, Request
from pydantic import ValidationError
from starlette.responses import Response

import main


ROOT = Path(__file__).resolve().parents[1]


class SecurityContractTests(unittest.TestCase):
    def test_pin_hash_is_salted_and_verifiable(self):
        first = main.hash_pin("1234")
        second = main.hash_pin("1234")
        self.assertNotEqual(first, second)
        self.assertTrue(main.verify_pin("1234", first))
        self.assertFalse(main.verify_pin("4321", first))

    def test_login_and_vote_models_do_not_accept_client_member_id(self):
        login_schema = main.MemberLogin.model_json_schema()["properties"]
        vote_schema = main.VoteCreate.model_json_schema()["properties"]
        suggestion_schema = main.SuggestionCreate.model_json_schema()["properties"]
        self.assertEqual(set(login_schema), {"display_name", "pin"})
        self.assertNotIn("member_id", vote_schema)
        self.assertNotIn("member_id", suggestion_schema)

    def test_pin_format_and_vote_bounds_are_validated(self):
        with self.assertRaises(ValidationError):
            main.MemberLogin(display_name="Florian", pin="abcd")
        with self.assertRaises(ValidationError):
            main.VoteCreate(suggestion_id=1, points=101)
        self.assertEqual(main.VoteCreate(suggestion_id=1, points=0).points, 0)

    def test_admin_password_uses_server_configuration(self):
        with patch.object(main, "ADMIN_PASSWORD", "test-secret"):
            main.require_admin("test-secret")
            with self.assertRaises(HTTPException) as context:
                main.require_admin("wrong")
            self.assertEqual(context.exception.status_code, 401)

    def test_security_headers_are_attached(self):
        request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})

        async def call_next(_request):
            return Response("ok")

        response = asyncio.run(main.security_headers(request, call_next))
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertIn("script-src 'self'", response.headers["content-security-policy"])


class OfflineFrontendContractTests(unittest.TestCase):
    def test_frontend_has_no_external_runtime_dependency(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("cdn.tailwindcss.com", html_source)
        self.assertNotIn("https://", html_source)
        self.assertIn('/static/app.css', html_source)
        self.assertIn('/static/app.js', html_source)

    def test_database_migration_contains_sessions_and_budget(self):
        schema = (ROOT / "bootstrap.py").read_text(encoding="utf-8")
        self.assertIn("music_member_sessions", schema)
        self.assertIn("pin_hash", schema)
        self.assertIn("max_budget", schema)


if __name__ == "__main__":
    unittest.main()
