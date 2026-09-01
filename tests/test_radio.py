import socketserver
import subprocess
import unittest
from unittest.mock import MagicMock, patch
from uuid import UUID

import requests
from fastapi import HTTPException

import main
import radio_directory as directory
with patch.object(socketserver, "UnixStreamServer",
                  getattr(socketserver, "UnixStreamServer", socketserver.TCPServer), create=True):
    import player_agent as agent


STATION_ID = "9e3b0f8e-95d3-11e9-a605-52543be04c81"


def row(**changes):
    return {"stationuuid": STATION_ID, "name": "NDR 2", "lastcheckok": 1,
            "url": "https://radio.example/list.m3u", "url_resolved": "https://radio.example/stream.mp3",
            "tags": "pop,rock", "country": "Germany", "codec": "MP3", **changes}


class RadioDirectoryTests(unittest.TestCase):
    def setUp(self):
        directory._cache.clear()

    @patch.object(directory, "directory_request", return_value=[row()])
    def test_searches_name_and_genre_and_deduplicates(self, request):
        stations = directory.search_stations("  NDR 2  ")
        self.assertEqual(len(stations), 1)
        self.assertEqual(stations[0]["stream_url"], "https://radio.example/stream.mp3")
        filters = [call.args[1] for call in request.call_args_list]
        self.assertTrue(any(item.get("name") == "NDR 2" for item in filters))
        self.assertTrue(any(item.get("tag") == "NDR 2" for item in filters))
        self.assertTrue(all(item["hidebroken"] == "true" for item in filters))
        stations[0]["name"] = "changed by caller"
        self.assertEqual(directory.search_stations("ndr 2")[0]["name"], "NDR 2")
        self.assertEqual(request.call_count, 2)

    def test_filters_broken_and_unsafe_entries(self):
        self.assertIsNone(directory.station_result(row(lastcheckok=0)))
        self.assertIsNone(directory.station_result(row(stationuuid="bad")))
        for url in ("file:///etc/passwd", "http://127.0.0.1/x", "http://10.42.0.1/x",
                    "http://router.local/x", "http://user:pass@radio.example/x", "http://[::1]/x"):
            with self.subTest(url=url):
                self.assertIsNone(directory.station_result(row(url=url, url_resolved=url)))
        self.assertIsNone(directory.station_result(row(favicon="javascript:alert(1)"))["logo_url"])

    @patch.object(directory, "directory_request", side_effect=directory.DirectoryUnavailable("offline"))
    def test_directory_failure_is_not_an_empty_success(self, request):
        with self.assertRaises(directory.DirectoryUnavailable):
            directory.search_stations("rock")
        self.assertFalse(directory._cache)

    @patch.object(directory, "directory_request")
    def test_one_failed_query_still_returns_other_results(self, request):
        request.side_effect = lambda path, params: [row()] if "tag" in params else (_ for _ in ()).throw(directory.DirectoryUnavailable())
        self.assertEqual(len(directory.search_stations("rock")), 1)
        self.assertFalse(directory._cache)

    @patch.object(directory.requests, "get", side_effect=requests.Timeout())
    def test_timeout_has_actionable_message(self, request):
        with self.assertRaisesRegex(directory.DirectoryUnavailable, "Internetverbindung am Raspberry"):
            directory.directory_request("/json/stations/search")
        self.assertEqual(request.call_args.kwargs["timeout"], (3, 7))
        self.assertIn("ClubIQ-Music", request.call_args.kwargs["headers"]["User-Agent"])

    @patch.object(directory.requests, "get")
    def test_malformed_response_has_actionable_message(self, request):
        request.return_value.json.return_value = {"error": "unavailable"}
        with self.assertRaises(directory.DirectoryUnavailable):
            directory.directory_request("/json/stations/search")

    @patch.object(directory, "directory_request", return_value=[row()])
    def test_import_re_resolves_uuid_server_side(self, request):
        self.assertEqual(directory.get_station(STATION_ID)["name"], "NDR 2")
        request.assert_called_once_with("/json/stations/byuuid/" + STATION_ID)
        with self.assertRaises(ValueError):
            directory.get_station("../../secrets")

    @patch.object(directory, "directory_request")
    def test_empty_queries_never_reach_directory(self, request):
        for query in ("", "  ", "x", "x" * 81):
            with self.assertRaises(ValueError):
                directory.search_stations(query)
        request.assert_not_called()


class RadioApiTests(unittest.TestCase):
    def test_search_and_import_require_admin(self):
        for path in ("/api/v1/music/admin/radio/search", "/api/v1/music/admin/radio/import"):
            route = next(route for route in main.app.routes if getattr(route, "path", "") == path)
            self.assertIn(main.require_admin, [dependency.call for dependency in route.dependant.dependencies])

    @patch.object(main, "search_stations", side_effect=directory.DirectoryUnavailable("offline"))
    def test_api_returns_directory_failure_as_503(self, search):
        with self.assertRaises(HTTPException) as caught:
            main.search_radio_directory("rock")
        self.assertEqual(caught.exception.status_code, 503)

    @patch.object(main, "db_connect")
    @patch.object(main, "get_station", return_value=directory.station_result(row()))
    def test_duplicate_import_does_not_insert_or_overwrite(self, station, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (7,)
        result = main.import_radio_station(main.RadioStationImport(station_uuid=UUID(STATION_ID)))
        self.assertEqual(result, {"status": "existing", "id": 7})
        self.assertFalse(any("INSERT" in call.args[0] for call in cursor.execute.call_args_list))

    @patch.object(main, "db_connect")
    @patch.object(main, "get_station", return_value=directory.station_result(row()))
    def test_new_import_uses_directory_stream_not_browser_input(self, station, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.side_effect = [None, (8,)]
        result = main.import_radio_station(main.RadioStationImport(station_uuid=UUID(STATION_ID)))
        self.assertEqual(result["id"], 8)
        insert = next(call for call in cursor.execute.call_args_list if "INSERT" in call.args[0])
        self.assertEqual(insert.args[1][1], "https://radio.example/stream.mp3")


class RadioPlayerTests(unittest.TestCase):
    def setUp(self):
        with patch.object(agent.MpvController, "load_state"):
            self.player = agent.MpvController()

    @patch.object(agent, "MPV_LOG_FILE")
    @patch.object(agent, "MPV_SOCKET")
    @patch.object(agent.subprocess, "Popen")
    @patch.object(agent, "device_info", return_value={"connected": True})
    def test_mpv_start_uses_supported_options_and_preserves_mute(self, info, popen, ipc, log):
        self.player.connected_speaker = "02:11:22:33:44:55"
        self.player.muted = True
        log.exists.return_value = False
        ipc.exists.return_value = True
        self.player.ensure_mpv()
        command = popen.call_args.args[0]
        self.assertIn("--audio-fallback-to-null=no", command)
        self.assertNotIn("--audio-fallback=no", command)
        self.assertIn("--mute=yes", command)
        self.assertIn("--audio-device=alsa/bluealsa:DEV=02:11:22:33:44:55,PROFILE=a2dp,SOFTVOL=yes", command)

    def test_radio_resume_does_not_switch_to_youtube_playlist(self):
        self.player.source_mode = "radio"
        self.player.radio_station = {"id": 5, "name": "Test", "stream_url": "https://radio.example/stream"}
        self.player.queue = [{"url": "https://www.youtube.com/watch?v=test123"}]
        self.player.current_index = 0
        with patch.object(self.player, "state", return_value={}), patch.object(self.player, "save_state"), \
             patch.object(self.player, "property", return_value=True), patch.object(self.player, "play_radio") as radio, \
             patch.object(self.player, "load_current") as playlist:
            self.player.act("play")
            radio.assert_called_once_with(self.player.radio_station)
            playlist.assert_not_called()

    def test_radio_next_previous_seek_leave_saved_playlist_untouched(self):
        self.player.source_mode = "radio"
        self.player.queue = [{"url": "a"}, {"url": "b"}]
        self.player.current_index = 0
        with patch.object(self.player, "state", return_value={}), patch.object(self.player, "command") as command, \
             patch.object(self.player, "load_current") as playlist:
            for action in ("next", "previous", "seek"):
                self.player.act(action, 10)
            self.assertEqual(self.player.current_index, 0)
            playlist.assert_not_called()
            command.assert_not_called()

