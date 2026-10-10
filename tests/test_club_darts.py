import unittest
from unittest.mock import patch
from datetime import datetime, timezone

from pydantic import ValidationError
from darts_clubs import DartsSettings, collect_season, source_ids, preview_source, config_hash


class ClubDartsTests(unittest.TestCase):
    def test_only_public_3k_league_links_are_accepted(self):
        valid='https://portal.3k-darts.com/frontend/events/10/event/123/phase/456/group/7'
        self.assertEqual(source_ids(valid),(123,456))
        for value in (valid.replace('https','http',1),valid.replace('portal.3k-darts.com','localhost'),
                      valid+'?target=http://localhost',valid.replace('portal.','secret@portal.'),
                      valid.replace('portal.3k-darts.com','portal.3k-darts.com:443'),valid.replace('/phase/456','/phase/0')):
            with self.assertRaises(ValueError):source_ids(value)

    def test_configuration_requires_unique_leagues_and_team_assignment(self):
        league={'url':'https://portal.3k-darts.com/frontend/events/10/event/123/phase/456','name':'Liga',
                'assignments':[{'team_key':'first','participant_id':789}]}
        self.assertTrue(DartsSettings(enabled=True,leagues=[league]).enabled)
        for values in ({'enabled':True},{'enabled':True,'leagues':[league,league]},
                       {'enabled':True,'leagues':[league,{**league,'url':league['url'].replace('/123/','/124/')} ]},
                       {'enabled':True,'leagues':[{**league,'assignments':[]}]},
                       {'enabled':True,'leagues':[{**league,'assignments':league['assignments']*2}]}):
            with self.assertRaises(ValidationError):DartsSettings(**values)
        self.assertEqual(config_hash({'a':1,'b':2}),config_hash({'b':2,'a':1}))

    def test_collects_configured_club_without_changing_barver_global_configuration(self):
        config={'enabled':True,'leagues':[{'url':'https://portal.3k-darts.com/frontend/events/10/event/123/phase/456','name':'Andere Liga','assignments':[{'team_key':'first','participant_id':789}]}]}
        match={'id':1,'eventId':123,'plannedAt':'2026-10-10T18:00:00+00:00','kind':'upcoming','home':'Andere Erste','away':'Gegner','homeTeamId':789,'awayTeamId':900,'barverTeams':['first'],'barverSides':{'first':'home'}}
        def load(league,now):
            self.assertEqual(league['teams'],{789:'first'})
            return {'league':{'key':league['key'],'name':league['name']},'rounds':[{'id':1}],
                    'standings':[{'id':900,'name':'Gegner','rank':2,'rankSource':'3k-placement'},{'id':789,'name':'Andere Erste','rank':1,'rankSource':'3k-placement'}],'matches':[match]}
        import darts_feed
        original=darts_feed.LEAGUES
        with patch('darts_clubs.feed._load_league_season',side_effect=load),patch('darts_clubs.feed._load_team_profile',return_value={'name':'Andere Erste','roster':[{'name':'Max Beispiel','role':'Kapitän'}],'venue':{}}),patch('darts_clubs.feed._load_home_venue',return_value={'name':'Vereinsheim','city':'Beispielstadt'}):
            result=collect_season(config,{'first':'Unsere Erste'},datetime.now(timezone.utc))
        self.assertEqual(result['matches'][0]['homeVenue']['city'],'Beispielstadt')
        self.assertEqual(result['teams'][0]['name'],'Unsere Erste')
        self.assertEqual(result['leagues'][0]['standings'][0]['rank'],1)
        self.assertIs(darts_feed.LEAGUES,original)
        self.assertNotIn('Barver',str(result))

    def test_incomplete_league_never_becomes_a_complete_snapshot(self):
        config={'enabled':True,'leagues':[{'url':'https://portal.3k-darts.com/frontend/events/10/event/123/phase/456','name':'Liga','assignments':[{'team_key':'first','participant_id':789}]}]}
        with patch('darts_clubs.feed._load_league_season',return_value={'degraded':True,'matches':[]}):
            with self.assertRaises(ValueError):collect_season(config,{})

    def test_source_preview_exposes_only_public_team_names_and_identifiers(self):
        with patch('darts_clubs.feed._public_get',side_effect=[{'rounds':[{'id':1}]},{'tableEntries':[{'tableEntries':[{'participantId':789,'participantName':'Unsere Erste','placement':'1','email':'private@example.test'}]}]}]):
            result=preview_source('https://portal.3k-darts.com/frontend/events/10/event/123/phase/456')
        self.assertEqual(result['teams'],[{'id':789,'name':'Unsere Erste'}])
        self.assertNotIn('private',str(result))
