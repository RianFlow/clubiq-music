from datetime import datetime, timedelta, timezone
import os
import unittest
from unittest.mock import Mock, patch

from darts_collector import verified_payload
from darts_feed import LEAGUES
import darts_fixtures as fixtures


class FixtureUpdatesTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 15, 17, tzinfo=timezone.utc)
        self.changed = {"id": 1296315, "eventId": 1460, "roundId": 34527, "kind": "upcoming", "barverTeams": ["D"],
                        "home": "OSC Damme D", "away": "SV Barver Darts D", "homeTeamId": 174268, "awayTeamId": 174266,
                        "barverSides": {"D": "away"}, "plannedAt": "2026-10-24T15:00:00+00:00",
                        "homeVenue": {"name": "Aqua Vital", "street": "Vördener Straße 19a", "city": "Damme"}, "venueChecked": True}
        self.old = {**self.changed, "home": "SV Barver Darts D", "away": "OSC Damme D", "homeTeamId": 174266,
                    "plannedAt": "2026-10-23T17:30:00+00:00", "homeVenue": {"name": "Barver", "city": "Barver"}}
        self.delta = {"scope": "fixtures", "league": {"key": "kk11"}, "updatedAt": self.now.isoformat(),
                      "roundIds": [34527], "matches": [self.changed], "sourceConnection": "collector"}
        self.base = {"stale": True, "updatedAt": (self.now-timedelta(days=3)).isoformat(),
                     "matches": [self.old], "teams": [{"code": "D", "nextMatch": self.old, "record": {"wins": 2}}]}

    def snapshot(self, key, *_):
        return self.delta if key == 'fixtures:kk11' else None

    def test_rescheduled_date_venue_and_home_away_apply_to_all_server_views(self):
        with patch.object(fixtures, 'collected_snapshot', side_effect=self.snapshot):
            result = fixtures.overlay_fixtures(self.base, self.now)
            ticker = fixtures.overlay_fixtures({**self.base, 'items': [self.old]}, self.now, ticker=True)
        for match in [result['matches'][0], result['teams'][0]['nextMatch'], result['teams'][0]['matches'][0], ticker['items'][0]]:
            self.assertEqual(match['plannedAt'], self.changed['plannedAt'])
            self.assertEqual(match['homeVenue']['city'], 'Damme')
            self.assertEqual(match['home'], 'OSC Damme D')
            self.assertEqual(match['barverSides'], {'D': 'away'})
        self.assertTrue(result['stale'], 'old standings must not appear fresh')
        self.assertEqual(result['updatedAt'], self.base['updatedAt'])
        self.assertEqual(self.base['matches'][0]['homeVenue']['city'], 'Barver', 'do not mutate cached base')

    def test_old_successful_update_survives_a_later_source_outage(self):
        self.delta['stale'] = True
        with patch.object(fixtures, 'collected_snapshot', side_effect=self.snapshot):
            result = fixtures.overlay_fixtures(self.base, self.now+timedelta(hours=2))
        self.assertEqual(result['matches'][0]['plannedAt'], self.changed['plannedAt'])
        self.assertTrue(result['fixturesStale'])

    def test_older_update_does_not_regress_newer_complete_season(self):
        self.base['updatedAt'] = (self.now+timedelta(minutes=1)).isoformat()
        with patch.object(fixtures, 'collected_snapshot', side_effect=self.snapshot):
            result = fixtures.overlay_fixtures(self.base, self.now)
        self.assertEqual(result['matches'][0]['plannedAt'], self.old['plannedAt'])

    def test_different_home_team_never_keeps_the_old_home_venue(self):
        self.changed.update(homeVenue={}, venueChecked=False)
        with patch.object(fixtures, 'collected_snapshot', side_effect=self.snapshot):
            result = fixtures.overlay_fixtures(self.base, self.now)
        self.assertEqual(result['matches'][0]['homeVenue'], {})

    def test_strict_source_validation(self):
        self.assertEqual(verified_payload('fixtures:kk11', self.delta, self.now)['scope'], 'fixtures')
        for changes in [{'scope': 'season'}, {'roundIds': []}, {'matches': [{**self.changed, 'eventId': 1445}]},
                        {'matches': [{**self.changed, 'barverTeams': ['A']}]}, {'matches': [{**self.changed, 'id': 0}]}]:
            with self.assertRaises(ValueError):
                verified_payload('fixtures:kk11', {**self.delta, **changes}, self.now)

    def test_fixture_reads_do_not_depend_on_tables_or_cup_and_strip_private_fields(self):
        league = LEAGUES[1]
        phase = {'rounds': [{'id': 34527, 'dateFrom': '2026-10-22T00:00:00Z'}]}
        raw = {'id': 1296315, 'statusCd': 'OPEN', 'eventId': 1460, 'datePlanned': self.changed['plannedAt'],
               'participantHome': {'id': 174268, 'displayName': 'OSC Damme D', 'email': 'private@example.invalid',
                'teamSeason': {'playingVenue': {'name': 'Aqua Vital', 'locationCity': 'Damme', 'phone': 'private'}}},
               'participantGuest': {'id': 174266, 'displayName': 'SV Barver Darts D'}}
        with patch.object(fixtures, '_read', side_effect=[phase, {'matches': [raw]}]) as read:
            result = fixtures.load_league_fixtures(league, self.now)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(result['matches'][0]['homeVenue']['city'], 'Damme')
        self.assertNotIn('private', str(result))

    def test_one_failed_league_does_not_block_the_other(self):
        with patch.dict(os.environ, {'DARTS_COLLECTOR_READ_ENABLED': '1'}), \
             patch.object(fixtures, 'collected_snapshot', return_value=None), \
             patch.object(fixtures, 'load_league_fixtures', side_effect=lambda league, *_: self.delta if league['key']=='kk11' else (_ for _ in ()).throw(TimeoutError())), \
             patch.object(fixtures, 'verified_payload', side_effect=lambda key, payload, now: payload), \
             patch.object(fixtures, 'persist_dataset') as persist:
            fixtures.refresh_fixture_snapshots()
        persist.assert_called_once_with('fixtures:kk11', self.delta)

    def test_moved_next_fixture_keeps_its_original_round_in_the_poll(self):
        phase = {'rounds': [{'id': 10, 'dateFrom': '2026-10-10T00:00:00Z'},
                            {'id': 11, 'dateFrom': '2026-10-20T00:00:00Z'},
                            {'id': 9, 'dateFrom': '2026-09-10T00:00:00Z'}]}
        with patch.object(fixtures, '_read', side_effect=[phase, {'matches': []}, {'matches': []}, {'matches': []}]):
            result = fixtures.load_league_fixtures(LEAGUES[1], self.now, {9})
        self.assertEqual(set(result['roundIds']), {9, 10, 11})
