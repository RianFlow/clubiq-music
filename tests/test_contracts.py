import asyncio
import re
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
    def test_archive_queue_requires_player_permission(self):
        for path in ("/api/v1/music/player/queue/current", "/api/v1/music/player/queue/cycles/{cycle_id}",
                     "/api/v1/music/player/bluetooth/saved", "/api/v1/music/player/bluetooth/reconnect"):
            route = next(route for route in main.app.routes if getattr(route, "path", None) == path)
            self.assertIn(main.require_player_operator, [dependency.call for dependency in route.dependant.dependencies])

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

    def test_player_permission_is_separate_and_radio_urls_are_validated(self):
        allowed = main.require_player_operator({
            "member_id": "member-1", "display_name": "DJ", "can_control_player": True,
        })
        self.assertEqual(allowed["member_id"], "member-1")
        with self.assertRaises(HTTPException) as context:
            main.require_player_operator({
                "member_id": "member-2", "display_name": "Gast", "can_control_player": False,
            })
        self.assertEqual(context.exception.status_code, 403)
        self.assertEqual(main.validate_media_url("https://radio.example/stream", "Stream", True),
                         "https://radio.example/stream")
        with self.assertRaises(HTTPException):
            main.validate_media_url("file:///etc/passwd", "Stream", True)

    def test_dj_queue_payloads_are_bounded(self):
        item = main.DjQueueItem(
            external_id="dQw4w9WgXcQ", title="Testtitel", position="next"
        )
        self.assertEqual(item.position, "next")
        with self.assertRaises(ValidationError):
            main.DjQueueItem(external_id="https://example.test", title="Test")
        with self.assertRaises(ValidationError):
            main.DjQueueMove(target_index=999)

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

    def test_playlist_rules_are_bounded(self):
        starts_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        closes_at = starts_at + timedelta(hours=3)
        cycle = main.CycleCreate(
            name="Vereinsabend", starts_at=starts_at, closes_at=closes_at,
            playlist_target_count=25, fallback_genre="Rock",
            reuse_previous_playlist=True, genre_fallback_enabled=True,
        )
        self.assertEqual(cycle.playlist_target_count, 25)
        self.assertEqual(cycle.fallback_genre, "Rock")
        with self.assertRaises(ValidationError):
            main.CycleCreate(
                name="Zu groß", starts_at=starts_at, closes_at=closes_at,
                playlist_target_count=51,
            )

    def test_playlist_sources_keep_priority_and_remove_duplicates(self):
        current = [
            {"external_id": "current001", "title": "Aktuell 1", "artist": "A"},
            {"external_id": "same000001", "title": "Aktuell 2", "artist": "B"},
        ]
        previous = [
            {"external_id": "same000001", "title": "Doppelt", "artist": "B"},
            {"external_id": "previous01", "title": "Vorher", "artist": "C"},
        ]
        genre = [
            {"external_id": "popular001", "title": "Genre", "artist": "D"},
            {"external_id": "popular002", "title": "Zu viel", "artist": "E"},
        ]
        merged = main.merge_playlist_sources(current, previous, genre, 4)
        self.assertEqual([item["external_id"] for item in merged], [
            "current001", "same000001", "previous01", "popular001",
        ])
        self.assertEqual([item["source"] for item in merged], [
            "votes", "votes", "previous", "genre",
        ])
        self.assertEqual(main.PREVIOUS_PLAYLIST_LIMIT, 5)

    def test_admin_password_uses_server_configuration(self):
        with patch.object(main, "ADMIN_PASSWORD", "test-secret"):
            main.require_admin("test-secret")
            with self.assertRaises(HTTPException) as context:
                main.require_admin("wrong")
            self.assertEqual(context.exception.status_code, 401)

    def test_darts_profile_admin_is_protected_and_payload_is_bounded(self):
        for path in (
            "/api/v1/darts/admin/players",
            "/api/v1/darts/admin/roster-cache",
            "/api/v1/darts/admin/players/{player_id}",
            "/api/v1/darts/admin/players/{player_id}/photo",
            "/api/v1/darts/admin/sponsors",
            "/api/v1/darts/admin/sponsors/{sponsor_id}",
            "/api/v1/darts/admin/sponsors/{sponsor_id}/logo",
        ):
            routes = [route for route in main.app.routes if getattr(route, "path", None) == path]
            self.assertTrue(routes, path)
            for route in routes:
                self.assertIn(main.require_darts_admin, [dependency.call for dependency in route.dependant.dependencies])
        profile = main.DartsPlayerProfileUpdate(
            player_number="Q8V4", alias="Peddy", favorite_finish="D16", published=True,
        )
        self.assertEqual(profile.player_number, "Q8V4")
        with self.assertRaises(ValidationError):
            main.DartsPlayerProfileUpdate(player_number="ungültig!", published=True)
        with self.assertRaises(ValidationError):
            main.DartsPlayerProfileUpdate(weight_grams=99, published=True)
        created = main.DartsPlayerCreate(name="Neue Spielerin", team="C", role="Spielerin")
        self.assertEqual(created.team, "C")
        with self.assertRaises(ValidationError):
            main.DartsPlayerCreate(name="X", team="E")

        sponsor = main.DartsSponsorUpdate(
            name="Hauptpartner", sponsor_type="main", placements=["footer", "tv"], priority=100
        )
        parsed = main._validated_sponsor_payload(sponsor)
        self.assertEqual(parsed["placements"], ["footer", "tv"])
        with self.assertRaises(HTTPException):
            main._validated_sponsor_payload(main.DartsSponsorUpdate(
                name="Teampartner", sponsor_type="team", teams=[], placements=["tv"]
            ))
        with self.assertRaises(HTTPException):
            main._validated_sponsor_payload(main.DartsSponsorUpdate(
                name="Eventpartner", sponsor_type="event", placements=["match"]
            ))
        with self.assertRaises(HTTPException):
            main._validated_sponsor_payload(main.DartsSponsorUpdate(
                name="Unsicher", website="http://example.test", placements=["footer"]
            ))

    def test_darts_profile_images_validate_content_not_filename(self):
        media_type, data = main._validated_player_image(b"RIFF\x00\x00\x00\x00WEBPpayload")
        self.assertEqual(media_type, "image/webp")
        self.assertEqual(data[-7:], b"payload")
        with self.assertRaises(HTTPException):
            main._validated_player_image(b"<script>alert(1)</script>")

    def test_unpublished_darts_profile_is_not_public(self):
        stored = {
            "1": {"published": False},
            "2": {
                "published": True, "alias": "Freigegeben", "gender": "", "playerNumber": "",
                "image": "/api/v1/darts/players/2/photo?v=1",
                "personal": {"darts": "", "weightGrams": None, "favoritePdcPlayer": "", "favoriteFinish": "", "finishRoute": "", "walkOnSong": ""},
            },
        }
        with patch.object(main, "_base_darts_player_profiles", return_value={"1": {"alias": "Alt"}}), \
             patch.object(main, "_darts_profile_rows", return_value=stored):
            public = main._public_darts_profiles()
        self.assertNotIn("1", public)
        self.assertEqual(public["2"]["alias"], "Freigegeben")

    def test_security_headers_are_attached(self):
        request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})

        async def call_next(_request):
            return Response("ok")

        response = asyncio.run(main.security_headers(request, call_next))
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertIn("script-src 'self'", response.headers["content-security-policy"])
        self.assertIn("frame-src https://www.youtube-nocookie.com;", response.headers["content-security-policy"])


class OfflineFrontendContractTests(unittest.TestCase):
    def test_frontend_has_no_external_runtime_dependency(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("cdn.tailwindcss.com", html_source)
        runtime_urls = re.findall(
            r'(?:src|href)\s*=\s*["\']([^"\']+)["\']',
            html_source,
            flags=re.IGNORECASE,
        )
        external_runtime_urls = [
            url for url in runtime_urls
            if url.startswith(("http://", "https://", "//"))
        ]
        self.assertEqual(external_runtime_urls, [])
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

    def test_bluetooth_errors_remain_visible_inside_admin_dialog(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        admin_dialog = html_source.split('<dialog id="adminDialog"', 1)[1].split('</dialog>', 1)[0]
        self.assertIn('id="speakerStatus"', admin_dialog)
        self.assertIn('speakerMessage(error.message, true)', script_source)
        self.assertIn('host.append(node)', script_source)
        self.assertIn('dialog[open]', script_source)

    def test_bluetooth_connection_waits_for_all_agent_steps(self):
        with patch.object(main, "player_agent", return_value={"device": {}}) as agent:
            main.bluetooth_action("connect", main.BluetoothDeviceAction(address="02:11:22:33:44:55"))
        self.assertEqual(agent.call_args.kwargs["timeout"], 90)

    def test_activity_and_dj_queue_controls_are_present(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        agent_source = (ROOT / "player_agent.py").read_text(encoding="utf-8")
        self.assertIn('id="activityLeaderboard"', html_source)
        self.assertIn('id="djSearchForm"', html_source)
        self.assertIn('/api/v1/music/activity?limit=8', script_source)
        self.assertIn('/api/v1/music/admin/player/queue', script_source)
        self.assertIn('if self.path == "/queue/add"', agent_source)
        self.assertIn('if self.path == "/queue/move"', agent_source)

    def test_cycle_form_and_countdown_are_present(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="cycleStartsAt" type="datetime-local"', html_source)
        self.assertIn('id="cycleClosesAt" type="datetime-local"', html_source)
        self.assertIn('id="cycleCountdown"', html_source)
        self.assertIn("function updateCountdown()", script_source)
        self.assertIn("refreshVotingState()", script_source)
        self.assertNotIn("duration_days", script_source)
        self.assertIn('id="cyclePlaylistTarget"', html_source)
        self.assertIn('id="cycleFallbackGenre"', html_source)
        self.assertIn("data-cycle-settings", script_source)
        self.assertIn("Aus den letzten fünf Playlists", html_source)

    def test_database_migration_contains_sessions_and_budget(self):
        schema = (ROOT / "bootstrap.py").read_text(encoding="utf-8")
        self.assertIn("music_member_sessions", schema)
        self.assertIn("pin_hash", schema)
        self.assertIn("max_budget", schema)
        self.assertIn("music_cycle_playlists", schema)
        self.assertIn("playlist_target_count", schema)
        self.assertIn("reuse_previous_playlist", schema)
        self.assertIn("darts_player_profiles", schema)
        self.assertIn("darts_player_profile_audit", schema)
        self.assertIn("darts_sponsors", schema)
        self.assertIn("darts_sponsor_audit", schema)

    def test_darts_admin_ui_is_local_and_consent_aware(self):
        html_source = (ROOT / "darts-admin.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "darts-admin.js").read_text(encoding="utf-8")
        self.assertIn("Profil veröffentlichen", html_source)
        self.assertIn("der Veröffentlichung zugestimmt", html_source)
        self.assertIn("/api/v1/darts/admin/players", script_source)
        self.assertIn("Neuen Spieler anlegen", html_source)
        self.assertIn("/api/v1/darts/admin/roster-cache", script_source)
        self.assertIn("/api/v1/darts/admin/sponsors", script_source)
        self.assertIn("Hauptpartner", html_source)
        self.assertIn("Veranstaltungspartner", html_source)
        self.assertIn("data-sponsor-placement", html_source)
        self.assertIn("image/webp", script_source)
        self.assertNotRegex(html_source, r'(?:src|href)=["\']https?://')

    def test_pwa_and_companion_views_are_local_only(self):
        manifest = (ROOT / "manifest.webmanifest").read_text(encoding="utf-8")
        service_worker = (ROOT / "sw.js").read_text(encoding="utf-8")
        remote = (ROOT / "remote.html").read_text(encoding="utf-8")
        party = (ROOT / "party.html").read_text(encoding="utf-8")
        self.assertIn('"display": "standalone"', manifest)
        self.assertIn('"sizes": "192x192"', manifest)
        self.assertIn('"sizes": "512x512"', manifest)
        self.assertIn('url.pathname.startsWith("/api/")', service_worker)
        self.assertNotIn("youtube", service_worker.lower())
        self.assertIn("DJ-Fernbedienung", remote)
        self.assertIn("Party-Anzeige", party)

    def test_player_recovery_and_backup_service_are_configured(self):
        agent = (ROOT / "player_agent.py").read_text(encoding="utf-8")
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        backup = (ROOT / "scripts" / "backup-loop.sh").read_text(encoding="utf-8")
        self.assertIn("def checkpoint_playback", agent)
        self.assertIn("def restore_session", agent)
        self.assertIn('"resume_position"', agent)
        self.assertIn("backup:", compose)
        self.assertIn("music_backups:/backups", compose)
        self.assertIn("pg_dump --clean", backup)
        self.assertIn(".clubiq-backup-target", backup)
        self.assertNotIn("zgrep", backup)
        self.assertIn('gzip -dc "$archive" | grep -q', backup)

    def test_player_permissions_and_radio_are_wired_end_to_end(self):
        schema = (ROOT / "bootstrap.py").read_text(encoding="utf-8")
        api = (ROOT / "main.py").read_text(encoding="utf-8")
        agent = (ROOT / "player_agent.py").read_text(encoding="utf-8")
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("can_control_player BOOLEAN NOT NULL DEFAULT FALSE", schema)
        self.assertIn("music_radio_stations", schema)
        self.assertIn("Depends(require_player_operator)", api)
        self.assertIn('/api/v1/music/player/radio/{station_id}/play', api)
        self.assertIn('if self.path == "/radio"', agent)
        self.assertIn('id="radioStations"', html_source)
        self.assertIn("data-toggle-player", script_source)

    def test_main_page_links_companion_views_and_installation(self):
        html_source = (ROOT / "index.html").read_text(encoding="utf-8")
        script_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('rel="manifest"', html_source)
        self.assertIn('href="/remote"', html_source)
        self.assertIn('href="/party"', html_source)
        self.assertIn('id="installPwa"', html_source)
        self.assertIn("beforeinstallprompt", script_source)
        self.assertIn('/api/v1/music/admin/backup/status', script_source)


if __name__ == "__main__":
    unittest.main()
