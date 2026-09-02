from array import array
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch
import wave

from fastapi import HTTPException

import main
from soundboard_pack import CATEGORIES, PACK_DIR, RETIRED_KEYS, seed_soundboard


class SoundPackTests(unittest.TestCase):
    def test_pack_has_13_unique_real_recordings_with_provenance_and_bounded_audio(self):
        items = json.loads((PACK_DIR / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(items), 13)
        self.assertEqual(len({item["key"] for item in items}), 13)
        self.assertEqual(len({item["name"] for item in items}), 13)
        self.assertEqual({p.name for p in PACK_DIR.glob("*.wav")}, {item["file"] for item in items})
        credits = (PACK_DIR.parent / "static" / "soundboard-credits.html").read_text(encoding="utf-8")
        for item in items:
            with self.subTest(sound=item["key"]):
                self.assertIn(item["category"], CATEGORIES)
                self.assertNotIn(item["key"], RETIRED_KEYS)
                self.assertNotIn("voice", item)
                source = item["source"]
                self.assertEqual(source["kind"], "recording")
                self.assertIn(source["license"], ("CC0-1.0", "CC-BY-4.0"))
                self.assertRegex(source["download_sha256"], r"^[a-f0-9]{64}$")
                self.assertTrue(source["recording_evidence"])
                self.assertTrue(source["edits"])
                self.assertIn(source["url"], credits)
                self.assertIn(source["author"], credits)
                self.assertIn(source["license_url"], credits)
                path = PACK_DIR / item["file"]
                self.assertEqual(path.parent, PACK_DIR)
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])
                self.assertLess(path.stat().st_size, main.MAX_SOUNDBOARD_BYTES)
                with wave.open(str(path)) as wav:
                    self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 22050))
                    duration = wav.getnframes() / wav.getframerate()
                    self.assertGreater(duration, .2)
                    self.assertLess(duration, 10)
                    self.assertAlmostEqual(item["duration_ms"], duration * 1000, delta=1)
                    pcm = array("h", wav.readframes(wav.getnframes()))
                if sys.byteorder != "little":
                    pcm.byteswap()
                peak = max(abs(value) for value in pcm)
                self.assertGreater(peak, 1000)
                self.assertLessEqual(peak, 16384)

    def test_seed_is_idempotent_and_does_not_restore_hidden_sounds(self):
        cursor = MagicMock()
        cursor.fetchall.return_value = []
        seed_soundboard(cursor)
        inserts = [call for call in cursor.execute.call_args_list if "INSERT" in call.args[0]]
        self.assertEqual(len(inserts), 13)
        self.assertTrue(all("ON CONFLICT (builtin_key) DO NOTHING" in call.args[0] for call in inserts))
        installed = [(call.args[1][0],) for call in inserts]
        cursor.reset_mock()
        cursor.fetchall.return_value = installed
        seed_soundboard(cursor)
        self.assertEqual(cursor.execute.call_count, 2)  # SELECT + retirement only
        self.assertNotIn("active = TRUE", cursor.execute.call_args_list[0].args[0])
        retirement, params = cursor.execute.call_args.args
        self.assertIn("SET active = FALSE", retirement)
        self.assertIn("builtin_key = ANY(%s)", retirement)
        self.assertEqual(params, (list(RETIRED_KEYS),))
        self.assertEqual(len(RETIRED_KEYS), 32)

    def test_checksum_failure_does_not_insert_bad_audio(self):
        cursor = MagicMock()
        cursor.fetchall.return_value = []
        with patch.object(Path, "read_bytes", return_value=b"corrupted"):
            with self.assertRaisesRegex(ValueError, "checksum"):
                seed_soundboard(cursor)
        cursor.execute.assert_called_once()

    def test_later_checksum_failure_does_not_partially_install_or_retire(self):
        cursor = MagicMock()
        cursor.fetchall.return_value = []
        original = Path.read_bytes
        def read(path):
            return b"bad" if path.name == "recorded-trombone.wav" else original(path)
        with patch.object(Path, "read_bytes", read):
            with self.assertRaisesRegex(ValueError, "checksum"):
                seed_soundboard(cursor)
        cursor.execute.assert_called_once()


class SoundboardApiTests(unittest.TestCase):
    def test_play_and_management_still_require_authorization(self):
        for path, method, permission in (
            ("/api/v1/music/player/soundboard/{item_id}/play", "POST", main.require_player_operator),
            ("/api/v1/music/admin/soundboard", "POST", main.require_admin),
            ("/api/v1/music/admin/soundboard/{item_id}", "DELETE", main.require_admin),
        ):
            route = next(route for route in main.app.routes if getattr(route, "path", "") == path and method in route.methods)
            self.assertIn(permission, [dep.call for dep in route.dependant.dependencies])

    @patch.object(main, "db_connect")
    def test_list_includes_categories_and_duration(self, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = [(1, "180!", "gold", "Darts", 2300, "clubiq-v1-180"),
                                       (2, "Eigener Sound", "green", "Eigene", None, None)]
        items = main.list_soundboard()["items"]
        self.assertEqual(items[0]["category"], "Darts")
        self.assertEqual(items[0]["duration_ms"], 2300)
        self.assertTrue(items[0]["builtin"])
        self.assertFalse(items[1]["builtin"])

    @patch.object(main, "db_connect")
    def test_remove_keeps_pack_id_so_it_cannot_reappear(self, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.rowcount = 1
        main.delete_soundboard(42)
        query, params = cursor.execute.call_args.args
        self.assertIn("SET active = FALSE", query)
        self.assertIn("active = TRUE", query)
        self.assertEqual(params, (42,))
        cursor.rowcount = 0
        with self.assertRaises(HTTPException) as ctx:
            main.delete_soundboard(42)
        self.assertEqual(ctx.exception.status_code, 404)

    @patch.object(main, "db_connect")
    def test_removed_audio_is_not_served(self, connect):
        cursor = connect.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = None
        with self.assertRaises(HTTPException) as ctx:
            main.soundboard_audio(42)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("active = TRUE", cursor.execute.call_args.args[0])
