import unittest
from unittest.mock import patch
import darts_tournament as feed


class TournamentTests(unittest.TestCase):
    def setUp(self):
        feed._cache = None
        feed._attempt = 0

    def test_created_event_excludes_payment_metadata(self):
        def get(url):
            if url.endswith('/participant'):
                return [{'id': 1, 'displayName': 'Spielerin Eins', 'paid': True, 'paidDate': 'private', 'email': 'private'}]
            return {'event': {'id': 22536, 'dbId': 5, 'name': 'Barver Open', 'statusCd': 'CREATED'}, 'phases': []}
        with patch.object(feed, '_get', side_effect=get):
            data = feed.get_tournament()
        self.assertFalse(data['scheduleReady'])
        self.assertEqual(data['participants'][0], {'id': 1, 'name': 'Spielerin Eins', 'waiting': False})

    def test_all_parallel_matches_and_stale_snapshot(self):
        def get(url):
            if url.endswith('/participant'): return []
            if url.endswith('/phase/2'): return {'rounds': [{'id': 3}]}
            if url.endswith('/round/3'):
                return {'matches': [{'id': i, 'statusCd': 'ACTIVE', 'board': str(i), 'participantHome': {'displayName': 'A'}, 'participantGuest': {'displayName': 'B'}} for i in range(1, 25)]}
            return {'event': {'id': 22536, 'dbId': 5}, 'phases': [{'id': 2}]}
        with patch.object(feed, '_get', side_effect=get), patch.object(feed, '_live', side_effect=lambda m: m):
            data = feed.get_tournament()
        self.assertEqual(len(data['matches']), 24)
        feed._attempt = 0
        with patch.object(feed, '_get', side_effect=ValueError('offline')):
            fallback = feed.get_tournament()
        self.assertTrue(fallback['stale'])
        self.assertEqual(len(fallback['matches']), 24)

    def test_byes_and_final_scores(self):
        self.assertIsNone(feed.match_model({'id': 2, 'byeHome': True}))
        match = feed.match_model({'id': 2, 'statusCd': 'FINISH', 'legsHome': 3, 'legsAway': 1, 'liveLegsHome': 2})
        self.assertEqual((match['kind'], match['homeLegs'], match['awayLegs']), ('final', 3, 1))

    def test_reject_wrong_database(self):
        with patch.object(feed, '_get', return_value={'event': {'id': 22536, 'dbId': 1}}):
            with self.assertRaises(RuntimeError): feed.get_tournament()


if __name__ == '__main__': unittest.main()
