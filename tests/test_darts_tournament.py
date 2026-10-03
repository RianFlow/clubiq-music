import unittest
from unittest.mock import patch
import darts_tournament as feed


class TournamentTests(unittest.TestCase):
    def setUp(self):
        feed._cache = None
        feed._attempt = 0
        feed._cache_key = None

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
        with patch.object(feed, '_get', side_effect=get), patch.object(feed, '_live_snapshot', return_value={}):
            data = feed.get_tournament()
        self.assertEqual(len(data['matches']), 24)
        feed._attempt = 0
        with patch.object(feed, '_get', side_effect=ValueError('offline')):
            fallback = feed.get_tournament()
        self.assertTrue(fallback['stale'])
        self.assertEqual(len(fallback['matches']), 24)

    def test_event_live_snapshot_maps_match_key_and_keeps_points_and_darts(self):
        payload = {"data": [{
            "id": 7874885, "matchKey": "4064263", "groupKey": "22536", "database": "5",
            "board": "5", "status": 1, "statusActive": True, "statusFinished": False,
            "currentplayerIndex": 0, "lastUpdate": "2026-10-03T14:10:06",
            "matchPlayers": [
                {"id": 1, "index": 0, "playerName": "Arne Könker", "points": 320, "darts": 12, "legs": 1},
                {"id": 2, "index": 1, "playerName": "Daniel Klapproth", "points": 410, "darts": 9, "legs": 0},
            ],
        }]}
        with patch.object(feed, '_get', return_value=payload):
            snapshot = feed._live_snapshot(22536, 5)
        self.assertEqual(snapshot[4064263]["home"]["points"], 320)
        self.assertEqual(snapshot[4064263]["home"]["darts"], 12)
        self.assertEqual(snapshot[4064263]["board"], "5")

    def test_byes_and_final_scores(self):
        self.assertIsNone(feed.match_model({'id': 2, 'byeHome': True}))
        match = feed.match_model({'id': 2, 'statusCd': 'FINISH', 'legsHome': 3, 'legsAway': 1, 'liveLegsHome': 2})
        self.assertEqual((match['kind'], match['homeLegs'], match['awayLegs']), ('final', 3, 1))

    def test_reject_wrong_database(self):
        with patch.object(feed, '_get', return_value={'event': {'id': 22536, 'dbId': 1}}):
            with self.assertRaises(RuntimeError): feed.get_tournament()

    def test_source_allowlist_and_normalization(self):
        source = 'https://portal.3k-darts.com/frontend/events/5/event/31849/phase/53660/group/403948?matchId=12'
        database, event, base, canonical = feed.tournament_source(source)
        self.assertEqual((database, event), (5, 31849))
        self.assertTrue(base.endswith('/event/31849'))
        self.assertTrue(canonical.endswith('/31849/participants'))
        for url in ['http://portal.3k-darts.com/frontend/events/5/event/1',
                    'https://evil.test/frontend/events/5/event/1',
                    'https://portal.3k-darts.com.evil.test/frontend/events/5/event/1',
                    'https://user:pass@portal.3k-darts.com/frontend/events/5/event/1',
                    'https://portal.3k-darts.com:444/frontend/events/5/event/1',
                    'https://portal.3k-darts.com/frontend/events/99/event/1']:
            with self.assertRaises(ValueError): feed.tournament_source(url)

    def test_group_rank_preserved_and_private_fields_omitted(self):
        raw = {'tableInfo': {'tableEntries': [{'name': 'Gruppe 2', 'tableEntries': [
            {'placement': '2.', 'participantName': 'B', 'matchCount': 4, 'win': 3, 'points1': 6, 'points2': 2, 'legs1': 10, 'legs2': 8, 'email': 'private'},
            {'placement': '1.', 'participantName': 'A', 'matchCount': 4, 'win': 4, 'participant': {'paid': True}},
        ]}]}}
        groups = feed.group_models(raw, 7, 8)
        self.assertEqual([e['rank'] for e in groups[0]['entries']], ['2.', '1.'])
        self.assertNotIn('email', str(groups)); self.assertNotIn('paid', str(groups))

    def test_new_event_never_returns_previous_events_stale_cache(self):
        feed._cache_key = (5, 22536)
        feed._cache = {'event': {'id': 22536}}
        with patch.object(feed, '_get', side_effect=ValueError('offline')):
            with self.assertRaises(RuntimeError): feed.get_tournament('https://portal.3k-darts.com/frontend/events/5/event/31849/participants')


if __name__ == '__main__': unittest.main()
