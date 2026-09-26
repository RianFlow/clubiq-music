import unittest

from darts_push import subscription_matches


class PreferencesTests(unittest.TestCase):
    def test_team_or_player_and_type(self):
        event = {"team": "A", "player": "Jannik Kläning", "event_type": "180"}
        self.assertTrue(subscription_matches(event, ["A"], [], ["180"]))
        self.assertTrue(subscription_matches(event, ["D"], ["Jannik Kläning"], ["180"]))
        self.assertFalse(subscription_matches(event, ["D"], [], ["180"]))
        self.assertFalse(subscription_matches(event, ["A"], ["Jannik Kläning"], ["leg"]))
        self.assertFalse(subscription_matches(event, [], [], ["180"]))
        self.assertFalse(subscription_matches(event, ["A"], [], []))

    def test_doubles_exact_names_not_substrings(self):
        event = {"team": "A", "player": "Jannik Kläning & Christian Fecht", "event_type": "game"}
        self.assertTrue(subscription_matches(event, [], [" jannik kläning "], ["game"]))
        self.assertTrue(subscription_matches(event, [], ["Christian Fecht"], ["game"]))
        self.assertFalse(subscription_matches(event, [], ["Jannik"], ["game"]))

    def test_team_total_does_not_leak_into_player_only_subscription(self):
        event = {"team": "A", "player": "SV Barver Darts A", "event_type": "match"}
        self.assertFalse(subscription_matches(event, [], ["Jannik Kläning"], ["match"]))
        self.assertTrue(subscription_matches(event, ["A"], [], ["match"]))
