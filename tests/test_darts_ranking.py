import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from fastapi import HTTPException, Response
import darts_ranking as ranking
import darts_tournament as tournament
import main

NOW = datetime(2026, 10, 5, tzinfo=timezone.utc)
PAYLOAD = {'tournamentSeries': {'id': 1282, 'name': 'DBD Rangliste 2026'}, 'events': [{'id': 30458, 'name': '9. Runde', 'datetime': '2026-09-19T12:00:00+02:00'}], 'ranking': [{'displayName': 'Testspieler', 'placement': 3, 'pointsTotal': 122, 'countEvents': 6, 'pointsAverageEvent': 20.333, 'member': [{'email': 'private'}], 'eventList': [{'id': 30458, 'pointsTotal': 0}, {'id': 999, 'pointsTotal': 30}]}]}

class RankingTests(unittest.TestCase):
    def setUp(self):
        ranking._cache = None
        tournament._series_cache.clear()

    def test_whitelist_official_rank_zero_points_and_round_membership(self):
        data = ranking._sanitize(PAYLOAD, NOW)
        self.assertEqual(data['rows'][0]['rank'], 3)
        self.assertEqual(data['rows'][0]['rounds'], [{'id': 30458, 'points': 0, 'rated': True}])
        self.assertNotIn('private', str(data))
        with self.assertRaises(ValueError): ranking._sanitize({'tournamentSeries': {'id': 1}}, NOW)

    def test_cache_and_offline_snapshot(self):
        with patch.object(ranking, '_public_get', return_value=PAYLOAD) as get:
            first = ranking.get_darts_ranking(NOW)
            self.assertEqual(first, ranking.get_darts_ranking(NOW + timedelta(minutes=1)))
            get.assert_called_once()
        with patch.object(ranking, '_public_get', side_effect=ValueError):
            self.assertTrue(ranking.get_darts_ranking(NOW + timedelta(minutes=11))['stale'])

    def test_tournament_selection_restricted_to_series_and_does_not_change_admin_default(self):
        data = ranking._sanitize(PAYLOAD, NOW)
        with patch.object(main, 'get_darts_ranking', return_value=data), patch.object(main, '_tournament_setting') as setting, patch.object(main, 'get_series_tournament', return_value={'ok': True}) as load:
            self.assertEqual(main.tournament_feed(Response(), 30458), {'ok': True})
            load.assert_called_once_with(data['events'][0]['sourceUrl'])
            with self.assertRaises(HTTPException) as caught: main.tournament_feed(Response(), 999)
            self.assertEqual(caught.exception.status_code, 404)
            setting.assert_not_called()

    def test_round_caches_and_failure_never_mix_events(self):
        a = 'https://portal.3k-darts.com/frontend/events/5/event/30458/participants'
        b = 'https://portal.3k-darts.com/frontend/events/5/event/29607/participants'
        with patch.object(tournament, '_load', side_effect=lambda source: {'source': source}) as load:
            self.assertEqual(tournament.get_series_tournament(a)['source'], a)
            self.assertEqual(tournament.get_series_tournament(b)['source'], b)
            self.assertEqual(tournament.get_series_tournament(a)['source'], a)
            self.assertEqual(load.call_count, 2)
        with patch.object(tournament, '_load', side_effect=ValueError):
            with self.assertRaises(RuntimeError): tournament.get_series_tournament(a.replace('30458', '21952'))
