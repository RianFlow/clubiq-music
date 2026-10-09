import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import requests
import darts_feed
from darts_feed import _barver_code_from_name, _game_events, _is_special_event, _leg_events, _live_game_events, _load_league_season, _load_season, _load_team_profile, _performance_events, _preferred_round, _preferred_round_by_matches, _public_game, _public_live_games, _relevant_rounds, _round_status, _season_match, _special_match, _standings, _team_record, _ticker_item


class DartsFeedTests(unittest.TestCase):
    def test_past_unreported_fixture_is_pending_not_live_or_a_fake_final(self):
        match = {'id': 1, 'statusCd': 'OPEN', 'datePlanned': '2026-10-02T17:30:00+00:00'}
        now = datetime(2026, 10, 3, 9, tzinfo=timezone.utc)
        item = _ticker_item(match, 1, 1, now)
        self.assertEqual(item['kind'], 'pending'); self.assertIsNone(item['score'])
        self.assertIn('Vorläufig beendet', item['text'])
        match['statusCd'] = 'FINISH'; match['setsHome'] = 7; match['setsAway'] = 5
        self.assertEqual(_ticker_item(match, 1, 1, now)['kind'], 'final')
        match['statusCd'] = 'OPEN'; match['datePlanned'] = '2026-10-30T17:30:00+00:00'
        self.assertEqual(_ticker_item(match, 1, 1, now)['kind'], 'live')

    def test_selects_previous_and_next_round(self):
        rounds = [
            {"id": 1, "dateFrom": "2026-09-04T00:00:00+02:00"},
            {"id": 2, "dateFrom": "2026-09-25T00:00:00+02:00"},
            {"id": 3, "dateFrom": "2026-10-09T00:00:00+02:00"},
        ]
        selected = _relevant_rounds(rounds, datetime(2026, 9, 21, tzinfo=timezone.utc))
        self.assertEqual([item["id"] for item in selected], [1, 2])

    def test_prefers_active_round_over_next_round(self):
        rounds = [
            {"id": 3, "dateFrom": "2026-09-24T22:00:00+00:00", "dateTo": "2026-09-26T22:00:00+00:00"},
            {"id": 4, "dateFrom": "2026-10-08T22:00:00+00:00", "dateTo": "2026-10-10T22:00:00+00:00"},
        ]
        selected = _preferred_round(rounds, datetime(2026, 9, 25, 18, 0, tzinfo=timezone.utc))
        self.assertEqual(selected["id"], 3)

    def test_prefers_next_round_outside_active_window(self):
        rounds = [
            {"id": 3, "dateFrom": "2026-09-24T22:00:00+00:00", "dateTo": "2026-09-26T22:00:00+00:00"},
            {"id": 4, "dateFrom": "2026-10-08T22:00:00+00:00", "dateTo": "2026-10-10T22:00:00+00:00"},
        ]
        selected = _preferred_round(rounds, datetime(2026, 9, 30, 18, 0, tzinfo=timezone.utc))
        self.assertEqual(selected["id"], 4)

    def test_postponed_open_match_keeps_older_round_selected(self):
        rounds = [
            {"id": 3, "dateFrom": "2026-09-24T22:00:00+00:00", "dateTo": "2026-09-26T22:00:00+00:00"},
            {"id": 4, "dateFrom": "2026-10-08T22:00:00+00:00", "dateTo": "2026-10-10T22:00:00+00:00"},
        ]
        matches = {
            3: [{"statusCd": "OPEN", "datePlanned": "2026-10-30T18:30:00+00:00"}],
            4: [{"statusCd": "OPEN", "datePlanned": "2026-10-09T18:30:00+00:00"}],
        }
        selected = _preferred_round_by_matches(rounds, matches, datetime(2026, 10, 12, tzinfo=timezone.utc))
        self.assertEqual(selected["id"], 3)
        self.assertEqual(_round_status(rounds[0], matches[3]), {"complete": False, "openMatches": 1, "movedMatches": 1})

    def test_finished_match_names_winner_and_whitelists_fields(self):
        match = {
            "id": 1280523,
            "eventId": 1445,
            "statusCd": "FINISH",
            "setsHome": 8,
            "setsAway": 4,
            "participantHome": {"id": 174110, "displayName": "SV Barver Darts A", "email": "private@example.test"},
            "participantGuest": {"id": 174115, "displayName": "TuS Lemförde A"},
            "datePlanned": "2026-09-17T18:30:00+02:00",
            "endDate": "2026-09-17T21:26:28+02:00",
        }
        item = _ticker_item(match, 2139, 34271)
        self.assertEqual(item["kind"], "final")
        self.assertEqual(item["text"], "SV Barver Darts A gewinnt 8:4 gegen TuS Lemförde A")
        self.assertNotIn("email", item)
        self.assertTrue(item["url"].endswith("?matchId=1280523"))

    def test_finished_away_win_displays_winner_score_first(self):
        match = {
            "id": 1296302,
            "eventId": 1460,
            "statusCd": "FINISH",
            "setsHome": 4,
            "setsAway": 8,
            "participantHome": {"id": 174266, "displayName": "SV Barver Darts D"},
            "participantGuest": {"id": 174262, "displayName": "TSV Drebber C"},
        }
        item = _ticker_item(match, 2154, 34524)
        self.assertEqual(item["text"], "TSV Drebber C gewinnt 8:4 gegen SV Barver Darts D")

    def test_standings_only_exposes_public_team_fields(self):
        matches = [{
            "participantHome": {"id": 174110, "displayName": "SV Barver Darts A", "rankingPos": 3, "email": "private@example.test"},
            "participantGuest": {"id": 1, "displayName": "Lohne", "rankingPos": 1, "phone": "secret"},
        }]
        standings = _standings(matches, {174110})
        self.assertEqual([entry["rank"] for entry in standings], [None, None])
        self.assertTrue(standings[1]["barver"])
        self.assertNotIn("email", str(standings))
        self.assertNotIn("phone", str(standings))

    def test_real_180_and_game_winner_events_are_normalized(self):
        match = {"id": 99}
        performances = [{"performanceTypeCd": "HS", "value": 180, "count": 2, "participant": {"displayName": "Jannik"}, "team": {"name": "SV Barver Darts A"}, "private": "removed"}]
        self.assertEqual(_performance_events(performances, match)[0]["title"], "180!")
        games = [{"gameNrRound": 2, "statusCd": "FINISH", "legsHome": 3, "legsAway": 1, "participantHome": {"displayName": "Jannik"}, "participantGuest": {"displayName": "Max"}}]
        self.assertEqual(_game_events(games, match)[0]["text"], "Jannik gewinnt 3:1 gegen Max")

    def test_high_finish_and_live_leg_are_normalized(self):
        match = {"id": 99}
        performances = [{"id": 4, "performanceTypeCd": "HF", "value": 111, "count": 1, "participant": {"displayName": "Jannik"}, "team": {"name": "SV Barver Darts A"}}]
        high_finish = _performance_events(performances, match)[0]
        self.assertEqual((high_finish["type"], high_finish["value"]), ("high_finish", 111))
        games = [{
            "id": 7, "gameNr": 2, "statusCd": "ACTIVE", "liveLegsHome": 2, "liveLegsAway": 1,
            "participantHome": {"displayName": "Jannik"}, "participantGuest": {"displayName": "Max"},
        }]
        legs = _leg_events(games, match, "SV Barver Darts A")
        self.assertEqual([(event["winnerSide"], event["legCount"]) for event in legs], [("home", 2), ("away", 1)])
        self.assertEqual(legs[0]["text"], "Jannik 2:1 Max")

    def test_live_ticker_points_are_whitelisted_as_remaining_scores(self):
        payload = {"data": [{
            "id": 777, "matchKey": "game-10", "status": 1, "statusActive": True,
            "currentplayerIndex": 0, "lastUpdate": "2026-09-26T12:00:00",
            "matchPlayers": [
                {"playerName": "Jannik", "points": 320, "legs": 2, "scoreTotal": 181, "dartsTotal": 9, "darts": 9, "lastScore": 60, "email": "hidden@example.test"},
                {"playerName": "Gegner 1", "points": 410, "legs": 1, "scoreTotal": 91},
            ],
        }]}
        live = _public_live_games(payload)
        self.assertEqual((live[0]["home"]["remaining"], live[0]["away"]["remaining"]), (320, 410))
        self.assertNotIn("scoreTotal", str(live))
        self.assertNotIn("email", str(live))
        self.assertEqual(live[0]["home"]["totalScore"], 181)
        self.assertEqual(live[0]["home"]["totalDarts"], 9)
        self.assertEqual(live[0]["home"]["darts"], 9)
        self.assertEqual(live[0]["home"]["average"], 60.3)
        event = _live_game_events(payload, {"id": 99}, "SV Barver Darts A")[0]
        self.assertEqual((event["homeName"], event["awayName"], event["homeRemaining"], event["awayRemaining"]), ("Jannik", "Gegner 1", 320, 410))
        self.assertEqual(event["home"]["lastScore"], 60)

    def test_report_score_is_never_misread_as_remaining_points(self):
        game = {
            "id": 8, "gameNr": 1, "statusCd": "ACTIVE", "liveLegsHome": 0, "liveLegsAway": 0,
            "participantHome": {"displayName": "Jannik", "score": 1500, "darts": 75},
            "participantGuest": {"displayName": "Gegner", "score": 900, "darts": 60},
        }
        public = _public_game(game)
        self.assertNotIn("remaining", public["home"])
        self.assertNotIn("remaining", public["away"])

    def test_season_match_adds_only_clubiq_team_and_round_metadata(self):
        match = {
            "id": 123, "eventId": 1445, "statusCd": "OPEN", "datePlanned": "2026-10-02T19:00:00+02:00",
            "participantHome": {"id": 174110, "displayName": "SV Barver Darts A", "email": "hidden@example.test"},
            "participantGuest": {"id": 9, "displayName": "Gast"},
        }
        league = {"key": "kl04", "name": "Kreisligen 04", "short": "KL 04", "event": 1445, "phase": 2139, "teams": {174110: "A"}}
        item = _season_match(match, league, {"id": 77, "name": "Spieltag 4", "dateFrom": "2026-10-02T00:00:00+02:00"})
        self.assertEqual((item["barverTeam"], item["barverTeams"], item["barverSides"], item["leagueShort"], item["round"]["id"]), ("A", ["A"], {"A": "home"}, "KL 04", 77))
        self.assertNotIn("email", str(item))

    def test_club_duel_is_assigned_to_both_barver_teams(self):
        match = {
            "id": 124, "eventId": 1445, "statusCd": "OPEN",
            "participantHome": {"id": 174112, "displayName": "SV Barver Darts C"},
            "participantGuest": {"id": 174110, "displayName": "SV Barver Darts A"},
        }
        league = {"key": "kl04", "name": "Kreisligen 04", "short": "KL 04", "event": 1445, "phase": 2139, "teams": {174110: "A", 174112: "C"}}
        item = _season_match(match, league, {"id": 78, "name": "Spieltag 5"})
        self.assertEqual(item["barverTeams"], ["A", "C"])
        self.assertEqual(item["barverSides"], {"C": "home", "A": "away"})

    def test_cup_team_numbers_map_to_stable_clubiq_codes(self):
        self.assertEqual(_barver_code_from_name("SV Barver Darts 1"), "A")
        self.assertEqual(_barver_code_from_name("SV Barver Darts 4"), "D")
        self.assertEqual(_barver_code_from_name("SV Barver Darts B"), "B")
        self.assertIsNone(_barver_code_from_name("SV Muster Darts 2"))

    def test_special_event_and_match_are_normalized(self):
        event = {"id": 1472, "name": "Bezirkspokal 2026/27", "nameShort": "BZP 26/27", "classification": {"name": "DVWE Bezirkspokale"}}
        self.assertTrue(_is_special_event(event))
        match = {
            "id": 1657285, "eventId": 1472, "statusCd": "OPEN", "datePlanned": "2026-09-27T11:00:00+00:00",
            "participantHome": {"id": 171591, "displayName": "VFL Emslage 1"},
            "participantGuest": {"id": 171513, "displayName": "SV Barver Darts 2"},
        }
        item = _special_match(match, event, {"id": 2180}, {"id": 32637, "name": "Runde der Letzten 64"})
        self.assertEqual((item["barverTeam"], item["barverSides"], item["competitionBadge"], item["leagueShort"]), ("B", {"B": "away"}, "POKAL", "POKAL"))
        self.assertTrue(item["isSpecial"])

    def test_team_record_includes_results_and_form(self):
        matches = [
            {"kind": "final", "score": "8:4", "barverTeams": ["A"], "barverSides": {"A": "home"}, "updatedAt": "2026-09-01"},
            {"kind": "final", "score": "5:7", "barverTeams": ["A"], "barverSides": {"A": "home"}, "updatedAt": "2026-09-02"},
            {"kind": "final", "score": "6:6", "barverTeams": ["A"], "barverSides": {"A": "away"}, "updatedAt": "2026-09-03"},
        ]
        record = _team_record(matches, "A")
        self.assertEqual((record["played"], record["wins"], record["draws"], record["losses"]), (3, 1, 1, 1))
        self.assertEqual(record["form"], ["S", "N", "U"])

    def test_single_round_timeout_keeps_league_season_available(self):
        league = {
            "key": "test", "name": "Testliga", "short": "TL",
            "event": 999, "phase": 888, "teams": {10: "A"},
        }
        rounds = [
            {"id": 1, "name": "Spieltag 1", "dateFrom": "2026-09-01T00:00:00+00:00", "dateTo": "2026-09-02T00:00:00+00:00"},
            {"id": 2, "name": "Spieltag 2", "dateFrom": "2026-10-01T00:00:00+00:00", "dateTo": "2026-10-02T00:00:00+00:00"},
        ]
        good_match = {
            "id": 77, "eventId": 999, "statusCd": "OPEN",
            "participantHome": {"id": 10, "displayName": "SV Barver Darts A", "rankingPos": 1},
            "participantGuest": {"id": 20, "displayName": "Gast", "rankingPos": 2},
            "datePlanned": "2026-10-01T18:00:00+00:00",
        }

        def fake_get(url):
            if url.endswith("/phase/0/round/0/table"):
                return {}
            if url.endswith("/phase/888"):
                return {"rounds": rounds}
            if url.endswith("/round/1"):
                raise requests.Timeout("3K zu langsam")
            if url.endswith("/round/2"):
                return {"matches": [good_match]}
            raise AssertionError(url)

        with patch("darts_feed._public_get", side_effect=fake_get):
            result = _load_league_season(league, datetime(2026, 9, 29, tzinfo=timezone.utc))

        self.assertTrue(result["degraded"])
        self.assertEqual(result["missingRoundIds"], [1])
        self.assertEqual(result["loadedRoundCount"], 1)
        self.assertEqual(result["totalRoundCount"], 2)
        self.assertEqual([item["id"] for item in result["matches"]], [77])
        self.assertEqual(result["selectedRound"]["id"], 2)

    def test_one_failed_league_does_not_abort_whole_season(self):
        leagues = (
            {"key": "one", "name": "Liga Eins", "short": "L1", "event": 1, "phase": 11, "teams": {101: "A"}},
            {"key": "two", "name": "Liga Zwei", "short": "L2", "event": 2, "phase": 22, "teams": {202: "D"}},
        )
        loaded = {
            "league": {"key": "one", "name": "Liga Eins", "short": "L1"},
            "rounds": [], "selectedRound": None, "standings": [], "matches": [],
            "degraded": False, "missingRoundIds": [], "loadedRoundCount": 0, "totalRoundCount": 0, "warning": None,
        }

        def fake_league(league, now):
            if league["key"] == "two":
                raise requests.Timeout("3K zu langsam")
            return loaded

        with patch.object(darts_feed, "LEAGUES", leagues), \
             patch.object(darts_feed, "_load_league_season", side_effect=fake_league), \
             patch.object(darts_feed, "_get_special_events", return_value={"available": False, "events": [], "matches": []}), \
             patch.object(darts_feed, "_load_team_profile", return_value={"name": "", "roster": [], "venue": {}, "weekday": None, "throwoffTime": None}):
            result = _load_season(datetime(2026, 9, 29, tzinfo=timezone.utc))

        self.assertTrue(result["degraded"])
        self.assertEqual(len(result["warnings"]), 1)
        self.assertEqual(result["warnings"][0]["league"], "two")
        self.assertEqual([item["league"]["key"] for item in result["leagues"]], ["one", "two"])

    def test_missing_team_profile_marks_season_incomplete(self):
        league = {"key": "one", "name": "Liga", "short": "L1", "event": 1, "phase": 11, "teams": {101: "A"}}
        loaded = {"league": {"key": "one"}, "rounds": [], "standings": [], "matches": [], "degraded": False}
        with patch.object(darts_feed, "LEAGUES", (league,)), \
             patch.object(darts_feed, "_load_league_season", return_value=loaded), \
             patch.object(darts_feed, "_get_special_events", return_value={}), \
             patch.object(darts_feed, "_load_team_profile", side_effect=requests.Timeout()):
            result = _load_season(datetime.now(timezone.utc))
        self.assertTrue(result["degraded"])
        self.assertEqual(result["warnings"][0]["missingTeamProfiles"], ["A"])

    def test_team_profile_exposes_player_id_but_no_private_registration_data(self):
        payload = {"participant": {"displayName": "SV Barver Darts B", "teamSeason": {"teamMembers": [
            {"displayName": "Berta Spielerin", "member": {"player": {"id": 89036, "genderCd": "W"}}},
            {"displayName": "Alex Stellvertreter", "tc2": True, "member": {"player": {"id": 89035}}},
            {"displayName": "Jannik Beispiel", "tc1": True,
             "member": {"id": 55, "player": {"id": 89034, "passNr": 47103326, "email": "hidden@example.test"}}},
        ]}}}
        with patch("darts_feed._public_get", return_value=payload):
            profile = _load_team_profile(174111)
        self.assertEqual([item["role"] for item in profile["roster"]], ["Kapitän", "Stellvertretung", "Spieler"])
        self.assertEqual(profile["roster"][0], {"id": 89034, "name": "Jannik Beispiel", "role": "Kapitän"})
        self.assertEqual(profile["roster"][2]["gender"], "female")
        self.assertNotIn("passNr", str(profile))
        self.assertNotIn("hidden@example.test", str(profile))

    def test_public_game_calculates_average_and_drops_private_fields(self):
        game = {
            "id": 8, "gameNr": 5, "statusCd": "FINISH", "legsHome": 3, "legsAway": 1,
            "participantHome": {"displayName": "Jannik & Tim", "score": 1500, "darts": 75, "email": "hidden@example.test"},
            "participantGuest": {"displayName": "Gast", "score": 900, "darts": 60},
        }
        public = _public_game(game)
        self.assertEqual((public["block"], public["home"]["average"], public["away"]["average"]), ("2. Block · Doppel", 60.0, 45.0))
        self.assertNotIn("email", str(public))


if __name__ == "__main__":
    unittest.main()


class OfficialStandingsTests(unittest.TestCase):
    def test_official_totals_are_whitelisted_with_missing_values_not_zero(self):
        from darts_feed import _official_standings, _league_standings
        raw = {"participantId":174110, "participantName":"Barver A", "participantRankingPos":3, "placement":"2.",
               "matchCount":3,"win":2,"tie":1,"lost":0,"points1":5.0,"points2":1.0,
               "sets1":24,"sets2":12,"legs1":70,"legs2":41,"participant":{"email":"private"}}
        rows = _official_standings({"tableEntries":[{"tableEntries":[raw]}]}, {174110})
        self.assertEqual(rows[0]['pointsFor'],5.0)
        self.assertEqual(rows[0]['played'],3)
        self.assertEqual(rows[0]['rank'],2)
        self.assertEqual(rows[0]['rankSource'],'3k-placement')
        self.assertTrue(rows[0]['barver'])
        self.assertNotIn('private',str(rows))
        del raw['points1']
        self.assertIsNone(_official_standings({"tableEntries":[{"tableEntries":[raw]}]},set())[0]['pointsFor'])
        with patch('darts_feed._public_get',side_effect=requests.Timeout):
            self.assertEqual(_league_standings({'event':1,'teams':{}},[]),[])

    def test_places_follow_official_placement_including_ties_and_missing_place(self):
        from darts_feed import _official_standings
        entries=[{"participantId":i+1,"participantName":f"Team {i}","placement":place,"participantRankingPos":seed,"points1":points}
                 for i,(place,seed,points) in enumerate([('1.',1,6),('2.',3,6),('2.',5,2),('4.',2,4),(None,8,1)])]
        rows=_official_standings({'tableEntries':[{'tableEntries':entries}]},set())
        self.assertEqual([row['rank'] for row in rows],[1,2,2,4,None])
        self.assertEqual([row['id'] for row in rows],[1,2,3,4,5])
        self.assertEqual([row['pointsFor'] for row in rows],[6,6,2,4,1])

    def test_invalid_placements_never_use_participant_seed(self):
        from darts_feed import _table_placement
        for value in [None,False,True,0,-1,'0.','-2.','2abc','1.-2.','']:
            with self.subTest(value=value):self.assertIsNone(_table_placement(value))
        for value in [2,'2',' 2. ']:self.assertEqual(_table_placement(value),2)
