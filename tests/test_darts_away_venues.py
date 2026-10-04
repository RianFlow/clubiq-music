import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import requests
import darts_feed as feed

class AwayVenueTests(unittest.TestCase):
    def setUp(self):
        feed._venue_cache.clear()

    def test_home_participant_address_is_whitelisted_and_cached(self):
        now = datetime(2026, 10, 5, tzinfo=timezone.utc)
        payload = {'participant': {'email': 'private', 'teamSeason': {'playingVenue': {'name': 'Heimverein', 'locationStreet': 'Testweg 4', 'locationPostalCode': '12345', 'locationCity': 'Teststadt', 'phone': 'private'}}}}
        with patch.object(feed, '_public_get', return_value=payload) as get:
            venue = feed._load_home_venue(174114, now)
            self.assertEqual(venue['street'], 'Testweg 4')
            self.assertNotIn('phone', venue)
            self.assertEqual(feed._load_home_venue(174114, now + timedelta(minutes=10)), venue)
            get.assert_called_once_with(f'{feed.FRONTEND_API}/participant/174114')
        with patch.object(feed, '_public_get', side_effect=requests.RequestException):
            self.assertEqual(feed._load_home_venue(174114, now + timedelta(hours=2)), venue)
            self.assertEqual(feed._load_home_venue(174115, now), {})

    def test_missing_house_number_is_not_invented(self):
        self.assertEqual(feed._safe_venue({'locationStreet': 'Stettiner Str.'})['street'], 'Stettiner Str.')
