import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from fastapi import HTTPException, Response
import darts_ranking as ranking
import darts_tournament as tournament
import main

NOW = datetime(2026, 10, 5, tzinfo=timezone.utc)
PAYLOAD = {'tournamentSeries': {'id': 1282, 'name': 'DBD Rangliste 2026'}, 'events': [{'id': 30458, 'name': '9. Runde', 'datetime': '2026-09-19T12:00:00+02:00'}], 'ranking': [{'displayName': 'Testspieler', 'placement': 3, 'pointsTotal': 122, 'countEvents': 6, 'pointsAverageEvent': 20.333, 'member': [{'email': 'private'}], 'eventList': [{'id': 30458, 'pointsTotal': 0}, {'id': 999, 'pointsTotal': 30}]}]}
UPCOMING = {'id':32680,'dbId':5,'name':'10. Runde (TSV Drebber)','datetime':'2026-10-23T17:00:00.000+0000','locationCity':'Drebber'}
CALENDAR = {'mandantKey':1931,'tournamentSeries':[{'id':1282,'eventList':[{**PAYLOAD['events'][0],'dbId':5},UPCOMING]}]}

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
        with patch.object(ranking, '_public_get', side_effect=[PAYLOAD,CALENDAR]) as get:
            first = ranking.get_darts_ranking(NOW)
            self.assertEqual(first, ranking.get_darts_ranking(NOW + timedelta(minutes=1)))
            self.assertEqual(get.call_count,2)
        with patch.object(ranking, '_public_get', side_effect=ValueError):
            self.assertTrue(ranking.get_darts_ranking(NOW + timedelta(minutes=11))['stale'])

    def test_calendar_includes_round_without_points_and_preserves_official_totals(self):
        with patch.object(ranking, '_public_get', side_effect=[PAYLOAD,CALENDAR]) as get:
            data = ranking._load(NOW)
        self.assertTrue(data['calendarAvailable'])
        self.assertEqual(len(data['events']),2)
        upcoming = next(event for event in data['events'] if event['id']==32680)
        self.assertFalse(upcoming['rated'])
        self.assertEqual(upcoming['start'],'2026-10-23T17:00:00.000+0000')
        self.assertTrue(upcoming['sourceUrl'].endswith('/32680/participants'))
        self.assertEqual((data['rows'][0]['rank'],data['rows'][0]['points'],data['rows'][0]['appearances']),(3,122,6))
        self.assertEqual(data['rows'][0]['rounds'],[{'id':30458,'points':0,'rated':True}])
        self.assertIn('/tournamentseries/1931?tournamentSeriesId=1282',get.call_args.args[0])
        with patch.object(main,'get_darts_ranking',return_value=data),patch.object(main,'get_series_tournament',return_value={'ok':True}) as load:
            self.assertEqual(main.tournament_feed(Response(),32680),{'ok':True})
            load.assert_called_once_with(upcoming['sourceUrl'])

    def test_exact_series_eventlist_fallback(self):
        calendar = {'mandantKey':1931,'tournamentSeries':[{'id':1282}]}
        with patch.object(ranking,'_public_get',side_effect=[PAYLOAD,calendar,CALENDAR['tournamentSeries'][0]['eventList']]) as get:
            self.assertEqual(len(ranking._load(NOW)['events']),2)
            self.assertTrue(get.call_args.args[0].endswith('/tournamentseries/1282/eventlist'))

    def test_invalid_calendar_cannot_replace_last_complete_snapshot(self):
        with patch.object(ranking,'_load',return_value=ranking._sanitize(PAYLOAD,NOW,CALENDAR['tournamentSeries'][0]['eventList'])):
            saved=ranking.get_darts_ranking(NOW)
        invalid=[{'mandantKey':999,'tournamentSeries':CALENDAR['tournamentSeries']},
                 {'mandantKey':1931,'tournamentSeries':[{'id':999,'eventList':[UPCOMING]}]},
                 {'mandantKey':1931,'tournamentSeries':[{'id':1282,'eventList':[]}]},
                 {'mandantKey':1931,'tournamentSeries':[{'id':1282,'eventList':[{**UPCOMING,'dbId':10}]}]}]
        for calendar in invalid:
            with patch.object(ranking,'_public_get',side_effect=[PAYLOAD,calendar]):
                data=ranking.get_darts_ranking(NOW+timedelta(minutes=11))
                self.assertTrue(data['stale'])
                self.assertEqual(data['updatedAt'],saved['updatedAt'])
                self.assertEqual(data['events'],saved['events'])

    def test_tentative_plan_has_no_time_or_event_link_and_disappears_when_published(self):
        data=ranking._sanitize(PAYLOAD,NOW)
        plan=data['plannedEvents'][0]
        self.assertEqual(plan['date'],'2026-11-22')
        self.assertFalse(plan['confirmed'])
        self.assertNotIn('id',plan)
        self.assertNotIn('sourceUrl',plan)
        self.assertNotIn('start',plan)
        published=[{**UPCOMING,'id':99999,'datetime':'2026-11-21T23:00:00.000+0000','locationCity':'Barver'}]
        self.assertEqual(ranking._sanitize(PAYLOAD,NOW,published)['plannedEvents'],[])
        self.assertEqual(ranking._sanitize(PAYLOAD,datetime(2026,11,23,tzinfo=timezone.utc))['plannedEvents'],[])

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
