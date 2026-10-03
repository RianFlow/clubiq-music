import unittest
from unittest.mock import MagicMock, patch
from fastapi import HTTPException, Response
import main


class TournamentAdminTests(unittest.TestCase):
    def test_all_settings_routes_protected(self):
        routes = [r for r in main.app.routes if getattr(r, 'path', '').startswith('/api/v1/darts/admin/tournament')]
        self.assertEqual(len(routes), 3)
        for route in routes:
            self.assertIn(main.require_admin, [d.call for d in route.dependant.dependencies])

    def test_bad_source_or_offline_never_changes_settings(self):
        update = main.DartsTournamentUpdate(source='https://evil.test/event/1')
        with patch.object(main, 'db_connect') as db:
            with self.assertRaises(HTTPException) as caught:
                main.darts_admin_set_tournament(update, Response())
            self.assertEqual(caught.exception.status_code, 422); db.assert_not_called()
        with patch.object(main, 'preview_tournament', side_effect=main.requests.RequestException), patch.object(main, 'db_connect') as db:
            with self.assertRaises(HTTPException) as caught:
                main.darts_admin_set_tournament(update, Response())
            self.assertEqual(caught.exception.status_code, 503); db.assert_not_called()

    def test_save_revalidates_and_commits_canonical_source(self):
        checked = {'source': 'https://portal.3k-darts.com/frontend/events/5/event/31849/participants',
                   'event': {'name': 'Training', 'date': '2026-10-04'}}
        connection = MagicMock(); cursor = connection.__enter__.return_value.cursor.return_value.__enter__.return_value
        response = Response()
        with patch.object(main, 'preview_tournament', return_value=checked) as preview, patch.object(main, 'db_connect', return_value=connection):
            result = main.darts_admin_set_tournament(main.DartsTournamentUpdate(source=checked['source']), response)
        preview.assert_called_once(); connection.__enter__.return_value.commit.assert_called_once()
        self.assertEqual(cursor.execute.call_args.args[1], (checked['source'], 'Training', '2026-10-04'))
        self.assertEqual(result, checked); self.assertEqual(response.headers['cache-control'], 'no-store')


if __name__ == '__main__': unittest.main()
