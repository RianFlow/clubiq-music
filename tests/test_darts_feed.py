import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from darts_feed import _barver_code_from_name, _game_events, _is_special_event, _leg_events, _live_game_events, _load_team_profile, _performance_events, _preferred_round, _public_game, _public_live_games, _relevant_rounds, _season_match, _special_match, _standings, _team_record, _ticker_item


class DartsFeedTests(unittest.TestCase):
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
        self.assertEqual([entry["rank"] for entry in standings], [1, 3])
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
                {"playerName": "Jannik", "points": 320, "legs": 2, "scoreTotal": 181, "email": "hidden@example.test"},
                {"playerName": "Gegner 1", "points": 410, "legs": 1, "scoreTotal": 91},
            ],
        }]}
        live = _public_live_games(payload)
        self.assertEqual((live[0]["home"]["remaining"], live[0]["away"]["remaining"]), (320, 410))
        self.assertNotIn("scoreTotal", str(live))
        self.assertNotIn("email", str(live))
        event = _live_game_events(payload, {"id": 99}, "SV Barver Darts A")[0]
        self.assertEqual((event["homeName"], event["awayName"], event["homeRemaining"], event["awayRemaining"]), ("Jannik", "Gegner 1", 320, 410))

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

    def test_team_profile_exposes_player_id_but_no_private_registration_data(self):
        payload = {"participant": {"displayName": "SV Barver Darts B", "teamSeason": {"teamMembers": [
            {"displayName": "Berta Spielerin", "member": {"player": {"id": 89036}}},
            {"displayName": "Alex Stellvertreter", "tc2": True, "member": {"player": {"id": 89035}}},
            {"displayName": "Jannik Beispiel", "tc1": True,
             "member": {"id": 55, "player": {"id": 89034, "passNr": 47103326, "email": "hidden@example.test"}}},
        ]}}}
        with patch("darts_feed._public_get", return_value=payload):
            profile = _load_team_profile(174111)
        self.assertEqual([item["role"] for item in profile["roster"]], ["Kapitän", "Stellvertretung", "Spieler"])
        self.assertEqual(profile["roster"][0], {"id": 89034, "name": "Jannik Beispiel", "role": "Kapitän"})
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
