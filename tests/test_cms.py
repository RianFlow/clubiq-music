import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError

from darts_cms import ClubCreate, Editor, PostSave, Publish, password_hash, password_matches, public_post


class CmsRulesTests(unittest.TestCase):
    def test_service_worker_excludes_private_cms_and_time_dependent_club_documents(self):
        source=(Path(__file__).resolve().parents[1] / 'sw.js').read_text()
        self.assertIn('url.pathname === "/cms"', source)
        self.assertIn('url.pathname.startsWith("/vereine/")', source)

    def test_inputs_reject_unsafe_addresses_colors_unknown_fields_and_invalid_media(self):
        for values in ({"name": "Verein", "slug": "../andere"},
                       {"name": "Verein", "slug": "verein", "accent": "url(javascript:alert(1))"},
                       {"name": "Verein", "slug": "verein", "role": "owner"}):
            with self.assertRaises(ValidationError):
                ClubCreate(**values)
        with self.assertRaises(ValidationError):
            PostSave(title="Neu", body="Ein Beitrag", image_id="-" * 36)
        with self.assertRaises(ValidationError):
            Editor(username="redaktion", password="kurz")

    def test_publish_window_requires_timezone_and_strict_order(self):
        with self.assertRaises(ValidationError):
            Publish(version=1, publish_at=datetime(2026, 10, 10))
        start = datetime.now(timezone.utc) + timedelta(days=1)
        with self.assertRaises(ValidationError):
            Publish(version=1, publish_at=start, expires_at=start)
        self.assertEqual(Publish(version=1, publish_at=start, expires_at=start + timedelta(hours=1)).publish_at, start)

    def test_passwords_are_salted_and_not_recoverable_from_stored_value(self):
        password = "eine-lange-test-passphrase"
        first, second = password_hash(password), password_hash(password)
        self.assertNotEqual(first, second)
        self.assertNotIn(password, first)
        self.assertTrue(password_matches(password, first))
        self.assertFalse(password_matches("falsch", first))
        self.assertFalse(password_matches(password, "kaputt"))

    def test_public_projection_contains_only_published_snapshot(self):
        at = datetime.now(timezone.utc)
        row = (7, 2, {"title": "Geheimer Entwurf", "body": "Privat"},
               {"title": "Öffentlich", "summary": "Kurz", "body": "Freigegeben", "image_id": None}, at, None, 8, 4, at)
        public = public_post(row, "verein")
        self.assertEqual(public["title"], "Öffentlich")
        self.assertNotIn("draft", public)
        self.assertNotIn("Privat", str(public))
        self.assertEqual(public["href"], "/vereine/verein/beitraege/7")

    def test_team_assignments_and_legacy_defaults(self):
        self.assertTrue(PostSave(title="Alt", body="Ohne neue Felder").show_home)
        self.assertEqual(PostSave(title="Neu",body="Nachricht",team_keys=["A","B","A"]).team_keys,["A","B"])
        for keys in (["../B"],["A' OR true --"]):
            with self.assertRaises(ValidationError):PostSave(title="Neu",body="Nachricht",team_keys=keys)
        with self.assertRaises(ValidationError):
            ClubCreate(name="Verein",slug="verein",teams=[{"key":"A","name":"Team A"},{"key":"A","name":"Team B"}])
