import json
import socketserver
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

import main
from music_library import duration_ms
with patch.object(socketserver, 'UnixStreamServer', getattr(socketserver, 'UnixStreamServer', socketserver.TCPServer), create=True):
    import player_agent as agent


class EveningTests(unittest.TestCase):
    def setUp(self):
        with patch.object(agent.MpvController, 'load_state'):
            self.p = agent.MpvController()
        self.p.save_state = MagicMock()
        self.p.command = MagicMock()
        self.p.ensure_mpv = MagicMock()
        self.p.connected_speaker = 'AA:BB:CC:DD:EE:FF'
        self.p.queue = [{'id':'test','title':'Song','artist':'Artist','url':'https://www.youtube.com/watch?v=aaaaaaaaaaa'}]
        self.p.current_index = 0
        self.props = {'idle-active':False,'pause':False,'paused-for-cache':False,'audio-params':{'samplerate':44100}}
        self.p.property = lambda key, default=None: self.props.get(key, default)
        self.station = {'id':1,'name':'Radio','stream_url':'https://radio.example/stream'}

    def test_only_actual_audio_is_recorded_without_urls(self):
        for key in ('pause','paused-for-cache','idle-active'):
            self.props[key] = True
            self.p.record_playback()
            self.assertEqual(self.p.history, [])
            self.props[key] = False
        self.p.record_playback()
        self.p.record_playback()
        self.assertEqual(len(self.p.history), 1)
        self.assertEqual(self.p.history[0]['external_id'], 'aaaaaaaaaaa')
        self.assertNotIn('url', json.dumps(self.p.history))

    def test_retries_and_reconnect_do_not_duplicate_history(self):
        self.p.record_playback()
        self.p.load_current(retry=True)
        self.p.playlist_loading = False
        self.p.record_playback()
        self.p.restore_session()
        self.p.playlist_loading = False
        self.p.record_playback()
        self.assertEqual(len(self.p.history), 1)
        self.p.load_current()
        self.p.playlist_loading = False
        self.p.record_playback()
        self.assertEqual(len(self.p.history), 2)

    def test_history_disk_persistence_is_bounded(self):
        self.p.history = [{'title':'old'}] * 500
        self.p.record_playback()
        self.assertEqual(len(self.p.history), 500)
        with tempfile.TemporaryDirectory() as folder, patch.object(agent, 'STATE_FILE', Path(folder) / 'player.json'):
            agent.MpvController.save_state(self.p)
            restored = agent.MpvController()
            self.assertEqual(len(restored.history), 500)
            self.assertTrue(restored.history_recorded)
            self.assertIsNone(restored.fallback_station)

    def test_fallback_off_by_default_and_pause_cancels(self):
        self.p.last_error = 'network'
        self.props['idle-active'] = True
        self.p.wants_playback = True
        self.p.check_fallback()
        self.assertIsNone(self.p.fallback_since)
        self.p.fallback_station = self.station
        self.p.check_fallback()
        self.assertIsNotNone(self.p.fallback_since)
        with patch.object(agent, 'device_info', return_value={'connected':True}):
            self.p.act('pause')
        self.p.check_fallback()
        self.assertIsNone(self.p.fallback_since)

    def test_fallback_waits_45_seconds_and_requires_connected_speaker(self):
        self.p.fallback_station = self.station
        self.p.wants_playback = True
        self.p.last_error = 'network'
        self.props['paused-for-cache'] = True
        with patch.object(agent, 'device_info', return_value={'connected':True}), patch.object(self.p,'play_radio') as radio:
            self.p.check_fallback()
            radio.assert_not_called()
            self.p.fallback_since = time.monotonic() - 46
            self.p.check_fallback()
            radio.assert_called_once_with(self.station)
            self.p.check_fallback()
            self.assertEqual(radio.call_count, 1)
            self.assertTrue(self.p.fallback_active)

    def test_no_fallback_on_bluetooth_loss_or_healthy_playback(self):
        self.p.fallback_station = self.station
        self.p.wants_playback = True
        self.p.fallback_since = time.monotonic() - 46
        self.p.check_fallback()
        self.assertIsNone(self.p.fallback_since)
        self.p.last_error = 'network'
        self.props['idle-active'] = True
        self.p.fallback_since = time.monotonic() - 46
        with patch.object(agent, 'device_info', return_value={'connected':False}), patch.object(self.p,'play_radio') as radio:
            self.p.check_fallback()
            radio.assert_not_called()

    def test_stale_error_does_not_switch_a_healthy_stream(self):
        self.p.fallback_station = self.station
        self.p.wants_playback = True
        self.p.last_error = 'An unrelated Bluetooth scan failed'
        self.p.fallback_since = time.monotonic() - 60
        with patch.object(self.p, 'play_radio') as radio:
            self.p.check_fallback()
            radio.assert_not_called()
            self.assertIsNone(self.p.fallback_since)

    def test_start_validation_precedes_mutation_and_is_idempotent(self):
        data = {'request_id':str(uuid4()), 'address':self.p.connected_speaker,'volume':40,'items':self.p.queue, 'station':None}
        with patch.object(agent, 'device_info', return_value={'paired':True}), patch.object(agent, 'connect_bluetooth_device') as connect, patch.object(self.p, 'stop_mpv'):
            self.p.start_evening(data)
            self.p.start_evening(data)
            connect.assert_called_once()
            self.assertEqual(self.p.volume, 40)
            self.assertFalse(self.p.muted)
            self.p.start_evening({**data,'request_id':str(uuid4()), 'volume':30})
            self.p.start_evening(data)
            self.assertEqual(connect.call_count,2, 'a delayed retry must not override a newer evening')
            self.assertEqual(self.p.volume,30)
            calls = self.p.command.call_count
            with self.assertRaises(ValueError):
                self.p.start_evening({**data,'request_id':str(uuid4()), 'volume':101})
            self.assertEqual(self.p.command.call_count, calls)

    def test_unpaired_speaker_does_not_stop_music(self):
        data = {'request_id':str(uuid4()),'address':self.p.connected_speaker,'volume':40,'items':self.p.queue}
        with patch.object(agent,'device_info', return_value={'paired':False,'trusted':False}):
            with self.assertRaises(ValueError):
                self.p.start_evening(data)
        self.p.command.assert_not_called()

    def test_new_routes_have_member_or_dj_guards(self):
        for route in main.app.routes:
            path = getattr(route, 'path', '')
            if '/library/' in path or '/evening/' in path or '/fallback/disable' in path:
                expected = main.require_member if '/library/' in path else main.require_player_operator
                self.assertIn(expected, [dep.call for dep in route.dependant.dependencies], path)

    def test_duration_parser(self):
        self.assertEqual(duration_ms('PT3M25S'), 205000)
        self.assertEqual(duration_ms('PT1H2M3S'), 3723000)
        self.assertIsNone(duration_ms('garbage'))

    def test_search_batches_metadata_and_keeps_results_on_metadata_failure(self):
        search = MagicMock()
        search.json.return_value = {'items':[{'id':{'videoId':'aaaaaaaaaaa'},'snippet':{'title':'A &amp; B','channelTitle':'Artist'}}]}
        metadata = MagicMock()
        metadata.json.return_value = {'items':[{'id':'aaaaaaaaaaa','contentDetails':{'duration':'PT3M25S'}}]}
        with patch.object(main, 'YOUTUBE_API_KEY', 'test-only'), patch.object(main.requests, 'get', side_effect=[search,metadata]) as request:
            results = main.youtube_search('example')
            self.assertEqual(results[0]['duration_ms'],205000)
            self.assertEqual(results[0]['title'],'A & B')
            self.assertEqual(request.call_count,2)
        with patch.object(main, 'YOUTUBE_API_KEY', 'test-only'), patch.object(main.requests, 'get', side_effect=[search,main.requests.Timeout()]):
            results = main.youtube_search('example')
            self.assertIsNone(results[0]['duration_ms'])
            self.assertEqual(results[0]['external_id'],'aaaaaaaaaaa')

    def test_evening_rejects_two_sources_before_loading(self):
        model = main.EveningStart(request_id=uuid4(), address=self.p.connected_speaker, volume=40, cycle_id=1, station_id=1)
        with patch.object(main,'player_agent') as bridge:
            with self.assertRaises(main.HTTPException):
                main.start_evening(model, {'member_id':'test'})
            bridge.assert_not_called()
