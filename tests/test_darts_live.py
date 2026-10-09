import unittest
from datetime import datetime, timezone

from darts_live import DartsLiveHub, _watch_live_candidate, detect_events, normalize_match, normalize_rest, timestamp_ns, source_timestamp, winning_legs


def raw_match(match_key="1657291", board="2", stamp="2026-09-27T13:35:52.718986398", **changes):
    value = {
        "id": 7801628, "matchKey": match_key, "database": "10", "groupKey": "1657285",
        "groupName": "VFL Emslage 1 - SV Barver Darts 2", "board": board,
        "currentplayerIndex": 0, "mode": "Best of 5 Legs", "setsHome": 5, "setsGuest": 0,
        "legsHome": 15, "legsGuest": 5, "status": 1, "statusActive": True,
        "statusFinished": False, "lastUpdate": stamp, "allInOneMatchdata": "private history",
        "matchPlayers": [
            {"id": 1, "index": 0, "playerName": "T. Dreyer & D. Laarmann", "points": 168, "lastScore": 57, "darts": 12, "legs": 2, "count180": 0, "highfinish": 40, "scoreTotal": 2257, "dartsTotal": 104, "email": "hidden@example.test"},
            {"id": 2, "index": 1, "playerName": "R. Tiedemann & J. Renzelmann", "points": 116, "lastScore": 140, "darts": 12, "legs": 2, "count180": 0, "highfinish": 36, "scoreTotal": 2340, "dartsTotal": 104},
        ],
    }
    value.update(changes)
    return value


META = {"id": 1657285, "home": "VFL Emslage 1", "away": "SV Barver Darts 2", "barverTeams": ["B"], "barverSides": {"B": "away"}}


class DartsLiveTests(unittest.TestCase):
    def test_completed_leg_score_finishes_board_without_source_flag(self):
        before = normalize_match(raw_match())
        players = [dict(player, legs=1 if index == 0 else 3) for index, player in enumerate(raw_match()["matchPlayers"])]
        for active in (False, True):
            after = normalize_match(raw_match(statusActive=active, statusFinished=False, matchPlayers=players))
            self.assertTrue(after["finished"])
            self.assertFalse(after["active"])
            self.assertEqual([event["type"] for event in detect_events(before, after, META)], ["leg", "game"])

    def test_display_finish_obeys_mode_and_preserves_checkout_between_legs(self):
        players = [dict(player, legs=1 if index == 0 else 3, points=0 if index else 100) for index, player in enumerate(raw_match()["matchPlayers"])]
        for mode, finished in (("Best of 5 Legs", True), ("First to 3 Legs", True), ("Best of 7 Legs", False), ("Best of 5 Sets", False), ("", False)):
            board = normalize_match(raw_match(mode=mode, matchPlayers=players))
            self.assertEqual(board["finished"], finished, mode)
        players[1]["legs"] = 2
        self.assertFalse(normalize_match(raw_match(matchPlayers=players))["finished"])

    def test_first_game_after_empty_snapshot_is_announced(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        hub.apply("1657285", [], "rest")
        players = [dict(p, legs=0, darts=0, points=501) for p in raw_match()["matchPlayers"]]
        first = normalize_match(raw_match(stamp=datetime.now(timezone.utc).isoformat(), matchPlayers=players))
        hub.apply("1657285", [first], "rest")
        self.assertEqual([e["type"] for e in hub.drain_events()], ["player_start"])

    def test_start_transition_and_initial_snapshot(self):
        players = [dict(p, legs=0, darts=0, points=501) for p in raw_match()["matchPlayers"]]
        before = normalize_match(raw_match(status=0, statusActive=False, statusComingSoon=True, matchPlayers=players))
        after = normalize_match(raw_match(stamp=datetime.now(timezone.utc).isoformat(), matchPlayers=players))
        self.assertEqual(detect_events(None, after, META), [])
        events = detect_events(before, after, META)
        self.assertEqual([e["type"] for e in events], ["player_start"])
        self.assertEqual(events[0]["board"], "2")
        self.assertEqual(events[0]["player"], after["guest"]["name"])
        self.assertEqual(detect_events(after, {**after, "currentPlayerIndex": 1}, META), [])

    def test_new_board_start_is_fresh_once_and_not_historical(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        hub.apply("1657285", [normalize_match(raw_match())], "rest")
        self.assertEqual(hub.drain_events(), [])
        players = [dict(p, legs=0, darts=0, points=501, count180=0, highfinish=0) for p in raw_match()["matchPlayers"]]
        new = normalize_match(raw_match("new-board", stamp=datetime.now(timezone.utc).isoformat(), matchPlayers=players))
        hub.apply("1657285", [new], "rest")
        self.assertEqual([e["type"] for e in hub.drain_events()], ["player_start"])
        hub.apply("1657285", [new], "stomp")
        self.assertEqual(hub.drain_events(), [])
        late = normalize_match(raw_match("old-board", stamp=datetime.now(timezone.utc).isoformat()))
        hub.apply("1657285", [late], "rest")
        self.assertEqual(hub.drain_events(), [])
        stale = {**new, "matchKey": "stale-board", "lastUpdateNs": new["lastUpdateNs"] - 61000000000}
        hub.apply("1657285", [stale], "rest")
        self.assertEqual(hub.drain_events(), [])

    def test_nanosecond_timestamp_order_is_preserved(self):
        self.assertLess(timestamp_ns("2026-09-27T13:35:52.718986397"), timestamp_ns("2026-09-27T13:35:52.718986398"))
        self.assertEqual(timestamp_ns("invalid"), 0)

    def test_unzoned_scorer_time_is_german_local_time_in_summer_and_winter(self):
        for local, utc, offset in [
            ("2026-10-09T19:54:46.115028486", "2026-10-09T17:54:46.115028486Z", "+02:00"),
            ("2026-11-09T19:54:46.115028486", "2026-11-09T18:54:46.115028486Z", "+01:00"),
        ]:
            self.assertEqual(timestamp_ns(local), timestamp_ns(utc))
            self.assertEqual(source_timestamp(local), local + offset)
            self.assertEqual(source_timestamp(utc), utc)
            mapped = normalize_match(raw_match(stamp=local))
            self.assertEqual(mapped["lastUpdate"], local + offset)
            self.assertEqual(mapped["lastUpdateNs"], timestamp_ns(utc))

    def test_mapper_whitelists_and_calculates_average(self):
        mapped = normalize_match(raw_match())
        self.assertEqual((mapped["groupKey"], mapped["board"], mapped["guest"]["points"]), ("1657285", "2", 116))
        self.assertEqual(mapped["guest"]["average"], 67.5)
        self.assertEqual(mapped["guest"]["darts"], 12)
        self.assertEqual(mapped["guest"]["lastScore"], 140)
        self.assertEqual(mapped["guest"]["totalDarts"], 104)
        self.assertEqual(mapped["guest"]["totalScore"], 2340)
        self.assertNotIn("allInOneMatchdata", str(mapped))
        self.assertNotIn("hidden@example.test", str(mapped))

    def test_unknown_live_totals_are_not_invented_as_zero(self):
        players = [{"id": 1, "index": 0, "playerName": "Heim"}, {"id": 2, "index": 1, "playerName": "Gast"}]
        mapped = normalize_match(raw_match(matchPlayers=players))
        for key in ("darts", "lastScore", "totalDarts", "totalScore", "average"):
            self.assertIsNone(mapped["guest"][key])

    def test_team_subscribers_receive_opponent_leg_and_game_wins(self):
        from darts_push import barver_push_event, subscription_matches
        players = [dict(player, legs=2 if index == 0 else 1) for index, player in enumerate(raw_match()["matchPlayers"])]
        before = normalize_match(raw_match(matchPlayers=players))
        players[0]["legs"] = 3
        after = normalize_match(raw_match(matchPlayers=players))
        for raw in detect_events(before, after, META):
            event = barver_push_event("live", raw)
            self.assertFalse(raw["barverWon"])
            self.assertTrue(subscription_matches(event, ["B"], [], ["leg", "game"]))
            self.assertFalse(subscription_matches(event, ["A"], [], ["leg", "game"]))

    def test_rest_keeps_all_parallel_boards(self):
        matches = normalize_rest({"data": [raw_match("board-1", "1"), raw_match("board-2", "2")]})
        self.assertEqual([(item["matchKey"], item["board"]) for item in matches], [("board-1", "1"), ("board-2", "2")])

    def test_transition_detects_only_barver_events(self):
        before = normalize_match(raw_match())
        updated_players = [dict(player) for player in raw_match()["matchPlayers"]]
        updated_players[1].update({"legs": 3, "count180": 1, "highfinish": 121})
        after = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000001", matchPlayers=updated_players))
        events = detect_events(before, after, META)
        self.assertEqual({event["type"] for event in events}, {"leg", "game", "180", "high_finish"})
        self.assertTrue(all(event["team"] == "SV Barver Darts B" for event in events))
        self.assertTrue(next(event for event in events if event["type"] == "leg")["barverWon"])

    def test_transition_events_are_only_in_updates_not_reconnect_snapshot(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        channel = hub.subscribe()
        before = normalize_match(raw_match())
        changed_players = [dict(player) for player in raw_match()["matchPlayers"]]
        changed_players[1]["count180"] = 1
        after = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000001", matchPlayers=changed_players))
        hub.apply("1657285", [before], "rest")
        self.assertEqual(channel.get_nowait()["group"]["events"], [])
        hub.apply("1657285", [after], "rest")
        update = channel.get_nowait()
        self.assertEqual([event["type"] for event in update["group"]["events"]], ["180"])
        self.assertNotIn("events", hub.snapshot()["groups"][0])

    def test_hub_rejects_stale_and_broadcasts_new_state(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        newer = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000002"))
        older = normalize_match(raw_match(stamp="2026-09-27T13:35:53.000000001", board="9"))
        self.assertTrue(hub.apply("1657285", [newer], "rest"))
        self.assertFalse(hub.apply("1657285", [older], "stomp"))
        self.assertEqual(hub.get_group("1657285")["matches"][0]["board"], "2")

    def test_upcoming_match_is_watched_around_planned_start(self):
        now = datetime(2026, 9, 28, 18, 0, tzinfo=timezone.utc)
        match = {**META, "kind": "upcoming", "plannedAt": "2026-09-28T17:30:00+00:00"}
        self.assertTrue(_watch_live_candidate(match, now))

    def test_win_and_loss_are_separate_leg_and_game_events_with_owned_player(self):
        from darts_push import barver_push_event, subscription_matches, push_payload
        import json
        for winner_side in (0, 1):
            players = [dict(player, legs=1 if index != winner_side else 2)
                       for index, player in enumerate(raw_match()["matchPlayers"])]
            before = normalize_match(raw_match(matchPlayers=players))
            players[winner_side]["legs"] = 3
            after = normalize_match(raw_match(matchPlayers=players))
            events = detect_events(before, after, {**META, "league": "kl04"})
            self.assertEqual([event["type"] for event in events], ["leg", "game"])
            self.assertTrue(all(event["player"] == after["guest"]["name"] for event in events))
            self.assertTrue(all(event["barverWon"] == (winner_side == 1) for event in events))
            self.assertIn("AVG", events[1]["text"])
            self.assertIn("3:1" if winner_side == 1 else "1:3", events[1]["text"])
            normalized = barver_push_event("live", events[1])
            self.assertTrue(subscription_matches(normalized, [], ["J. Renzelmann"], ["game"]))
            self.assertEqual(json.loads(push_payload(normalized))["gameId"], 1657291)
            self.assertEqual(normalized["event_id"], barver_push_event("kl04", events[1])["event_id"])
            self.assertEqual(detect_events(after, {**after, "finished": True}, META), [])

    def test_mode_threshold_does_not_call_three_legs_a_best_of_seven_win(self):
        self.assertEqual(winning_legs("Best of 5 Legs"), 3)
        self.assertEqual(winning_legs("Best of 7 Legs"), 4)
        self.assertEqual(winning_legs("First to 6 Legs"), 6)
        self.assertIsNone(winning_legs("Best of 5 Sets"))
        players = [dict(player, legs=2) for player in raw_match()["matchPlayers"]]
        before = normalize_match(raw_match(mode="Best of 7 Legs", matchPlayers=players))
        players[1]["legs"] = 3
        after = normalize_match(raw_match(mode="Best of 7 Legs", matchPlayers=players))
        self.assertEqual([event["type"] for event in detect_events(before, after, META)], ["leg"])
        players[1]["legs"] = 4
        final = normalize_match(raw_match(mode="Best of 7 Legs", matchPlayers=players))
        self.assertEqual([event["type"] for event in detect_events(after, final, META)], ["leg", "game"])

    def test_team_score_update_on_another_board_is_not_a_fake_player_win(self):
        before = normalize_match(raw_match())
        after = {**before, "teamScoreGuest": 1}
        self.assertEqual(detect_events(before, after, META), [])

    def test_derby_sends_both_team_outcomes_without_shared_identity(self):
        from darts_push import barver_push_event
        players = [dict(player, legs=2) for player in raw_match()["matchPlayers"]]
        before = normalize_match(raw_match(matchPlayers=players))
        players[1]["legs"] = 3
        after = normalize_match(raw_match(matchPlayers=players))
        meta = {**META, "barverSides": {"A": "home", "B": "away"}}
        events = detect_events(before, after, meta)
        games = [event for event in events if event["type"] == "game"]
        self.assertEqual([game["barverWon"] for game in games], [False, True])
        self.assertNotEqual(barver_push_event("live", games[0])["event_id"], barver_push_event("live", games[1])["event_id"])

    def test_distant_upcoming_match_is_not_watched(self):
        now = datetime(2026, 9, 28, 18, 0, tzinfo=timezone.utc)
        future = {**META, "kind": "upcoming", "plannedAt": "2026-10-02T17:30:00+00:00"}
        old = {**META, "kind": "upcoming", "plannedAt": "2026-09-28T08:00:00+00:00"}
        self.assertFalse(_watch_live_candidate(future, now))
        self.assertFalse(_watch_live_candidate(old, now))

    def test_reconcile_starts_connector_for_upcoming_match_in_live_window(self):
        created = []

        class FakeConnector:
            def __init__(self, hub, database, group_key):
                created.append(group_key)
            def start(self):
                pass
            def stop(self):
                pass

        hub = DartsLiveHub(FakeConnector)
        match = {**META, "kind": "upcoming", "plannedAt": datetime.now(timezone.utc).isoformat()}
        hub.reconcile([match])
        self.assertEqual(created, ["1657285"])

    def test_group_stays_open_between_finished_board_blocks(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        first = normalize_match(raw_match(
            "block-1-board-1", "1", "2026-09-27T13:35:53.000000001",
            setsHome=5, setsGuest=1, status=2, statusActive=False, statusFinished=True,
        ))
        second = normalize_match(raw_match(
            "block-1-board-2", "2", "2026-09-27T13:35:53.000000002",
            setsHome=5, setsGuest=1, status=2, statusActive=False, statusFinished=True,
        ))
        hub.apply("1657285", [first, second], "rest")
        self.assertFalse(hub.group_finished("1657285"))

    def test_group_finishes_at_twelve_team_games(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        final = normalize_match(raw_match(
            "final-board", "1", "2026-09-27T13:35:53.000000003",
            setsHome=8, setsGuest=4, status=2, statusActive=False, statusFinished=True,
        ))
        hub.apply("1657285", [final], "rest")
        self.assertTrue(hub.group_finished("1657285"))

    def test_final_season_status_finishes_group_and_stops_connector(self):
        stopped = []

        class FakeConnector:
            def __init__(self, hub, database, group_key):
                self.group_key = group_key
            def start(self):
                pass
            def stop(self):
                stopped.append(self.group_key)

        hub = DartsLiveHub(FakeConnector)
        live_match = {**META, "kind": "live", "score": "10:1"}
        hub.reconcile([live_match])
        hub.reconcile([{**META, "kind": "final", "score": "11:1", "updatedAt": "2026-09-28T22:04:18"}])

        group = hub.get_group("1657285")
        self.assertTrue(group["finished"])
        self.assertEqual(group["source"], "season")
        self.assertEqual(group["meta"]["score"], "11:1")
        self.assertEqual(stopped, ["1657285"])

    def test_reconcile_starts_only_one_connector_per_live_group(self):
        created = []

        class FakeConnector:
            def __init__(self, hub, database, group_key):
                created.append(group_key)
            def start(self):
                pass
            def stop(self):
                pass

        hub = DartsLiveHub(FakeConnector)
        match = {**META, "kind": "live", "barverTeam": "B", "league": "cup"}
        hub.reconcile([match, match])
        self.assertEqual(created, ["1657285"])

    def test_pending_retires_empty_watcher_without_claiming_final(self):
        hub = DartsLiveHub()
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        hub.reconcile([{**META, "kind": "pending"}])
        group = hub.get_group("1657285")
        self.assertTrue(group["retired"])
        self.assertFalse(group["finished"])
        self.assertTrue(hub._events.empty())

    def test_pending_keeps_fresh_active_board_then_retires_old_board(self):
        class FakeConnector:
            def __init__(self, *args):
                pass
            def start(self):
                pass
            def stop(self):
                pass

        hub = DartsLiveHub(FakeConnector)
        hub._groups["1657285"] = hub._empty_group("1657285", META)
        hub.apply("1657285", [normalize_match(raw_match(stamp=datetime.now(timezone.utc).isoformat()))], "rest")
        hub.reconcile([{**META, "kind": "pending"}])
        self.assertFalse(hub.get_group("1657285")["retired"])
        hub._groups["1657285"]["matches"]["1657291"]["lastUpdateNs"] -= 601 * 1_000_000_000
        hub.reconcile([{**META, "kind": "pending"}])
        self.assertTrue(hub.get_group("1657285")["retired"])
        self.assertFalse(hub.get_group("1657285")["finished"])


if __name__ == "__main__":
    unittest.main()
