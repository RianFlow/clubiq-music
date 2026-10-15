import unittest
from datetime import datetime, timezone
from fastapi import HTTPException
from pydantic import ValidationError
from darts_notices import NoticeUpdate, validate_target, validated_notice


class AppointmentNoticeTests(unittest.TestCase):
    def test_target_is_a_stable_game_event_or_specific_valid_training_date(self):
        for target in ['match-123', 'event-32680', 'training-2026-10-15']:
            self.assertEqual(validate_target(target), target)
        for target in ['match-0', 'training-2026-02-30', 'training-all', 'unknown-123', "match-1' OR TRUE", 'match-' + '9' * 20]:
            with self.assertRaises(HTTPException):
                validate_target(target)

    def test_plain_text_and_timezone_validation(self):
        update = NoticeUpdate(title=' Barver B ', message=' Achtung:  Spielort\n geändert! ', expires_at='2026-10-16T22:00:00+02:00')
        title, message, expires, active = validated_notice(update)
        self.assertEqual((title, message, active), ('Barver B', 'Achtung: Spielort geändert!', True))
        self.assertEqual(expires, datetime(2026, 10, 16, 20, tzinfo=timezone.utc))
        for changes in [{'message': '  '}, {'message': '\x00'}, {'expires_at': '2026-10-16T22:00:00'}]:
            with self.assertRaises(HTTPException):
                validated_notice(update.model_copy(update={**changes, **({'expires_at': datetime(2026, 10, 16)} if 'expires_at' in changes else {})}))
        with self.assertRaises(ValidationError):
            NoticeUpdate(title='B', message='a' * 241, expires_at=expires)
