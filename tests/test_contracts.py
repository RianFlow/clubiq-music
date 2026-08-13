import asyncio
import unittest
from datetime import datetime, timedelta, timezone
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
        register_schema = main.MemberRegister.model_json_schema()["properties"]
        vote_schema = main.VoteCreate.model_json_schema()["properties"]
        suggestion_schema = main.SuggestionCreate.model_json_schema()["properties"]
        self.assertEqual(set(login_schema), {"display_name", "pin"})
        self.assertEqual(set(register_schema), {"display_name", "pin"})
        self.assertNotIn("member_id", vote_schema)
        self.assertNotIn("member_id", suggestion_schema)

    def test_player_commands_are_strictly_limited(self):
        self.assertEqual(main.PlayerCommand(action="play").action, "play")
        with self.assertRaises(ValidationError):
            main.PlayerCommand(action="shell", value="reboot")

    def test_pin_format_and_vote_bounds_are_validated(self):
        with self.assertRaises(ValidationError):
            main.MemberLogin(display_name="Florian", pin="abcd")
        with self.assertRaises(ValidationError):
            main.MemberRegister(display_name="Florian", pin="123")
        with self.assertRaises(ValidationError):
            main.VoteCreate(suggestion_id=1, points=101)
        self.assertEqual(main.VoteCreate(suggestion_id=1, points=0).points, 0)

    def test_cycle_uses_exact_time_window(self):
        starts_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        closes_at = starts_at + timedelta(hours=3)
        cycle = main.CycleCreate(
            name="Vereinsabend", starts_at=starts_at, closes_at=closes_at, max_budget=10
        )
        normalized = main.validate_cycle_window(cycle.starts_at, cycle.closes_at)
        self.assertEqual(normalized, (starts_at, closes_at))
        with self.assertRaises(HTTPException):
            main.validate_cycle_window(closes_at, starts_at)
        with self.assertRaises(HTTPException):
            main.validate_cycle_window(starts_at.replace(tzinfo=None), closes_at)

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
        css_source = (ROOT / "static" / "app.css").read_text(encoding="utf-8")
        self.assertIn('/pics/sv-barver-darts.png', css_source)
        self.assertTrue((ROOT / "pics" / "sv-barver-darts.png").is_file())

    def test_self_registration_has_pin_confirmation(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="registerPinRepeat"', html_source)
        self.assertIn('/api/v1/music/auth/register', script_source)

    def test_logged_in_view_hides_all_guest_prompts(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        css_source = (ROOT / "static" / "app.css").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("data-guest-only", html_source)
        self.assertIn("[hidden] { display: none !important; }", css_source)
        self.assertIn("node.hidden = loggedIn", script_source)

    def test_player_and_bluetooth_ui_are_local_and_admin_controlled(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        compose_source = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        agent_source = (ROOT / "player_agent.py").read_text(encoding="utf-8")
        self.assertIn('id="tab-player"', html_source)
        self.assertIn('id="scanSpeakers"', html_source)
        self.assertIn('/api/v1/music/player/bluetooth/scan', script_source)
        self.assertIn('/run/clubiq-music:/run/clubiq-music', compose_source)
        self.assertIn("UnixStreamServer", agent_source)
        self.assertNotIn("0.0.0.0", agent_source)

    def test_cycle_form_and_countdown_are_present(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="cycleStartsAt" type="datetime-local"', html_source)
        self.assertIn('id="cycleClosesAt" type="datetime-local"', html_source)
        self.assertIn('id="cycleCountdown"', html_source)
        self.assertIn("function updateCountdown()", script_source)
        self.assertIn("refreshVotingState()", script_source)
        self.assertNotIn("duration_days", script_source)

    def test_database_migration_contains_sessions_and_budget(self):
        schema = (ROOT / "bootstrap.py").read_text(encoding="utf-8")
        self.assertIn("music_member_sessions", schema)
        self.assertIn("pin_hash", schema)
        self.assertIn("max_budget", schema)


if __name__ == "__main__":
    unittest.main()
