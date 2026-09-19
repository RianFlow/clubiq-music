"""Regressions for failed loads, EOF, retries and bounded next-track preparation."""
import json
import socketserver
import subprocess
import time
import unittest
from unittest.mock import MagicMock, patch

with patch.object(socketserver, 'UnixStreamServer',
                  getattr(socketserver, 'UnixStreamServer', socketserver.TCPServer), create=True):
    import player_agent as agent


class PlaybackTests(unittest.TestCase):
    def setUp(self):
        with patch.object(agent.MpvController, 'load_state'):
            self.player = agent.MpvController()
        self.player.queue = [
            {'id': 'a', 'title': 'A', 'url': 'https://www.youtube.com/watch?v=aaaaaaaaaaa'},
            {'id': 'b', 'title': 'B', 'url': 'https://www.youtube.com/watch?v=bbbbbbbbbbb'},
        ]
        self.player.current_index = 0
        self.player.save_state = MagicMock()
        self.player.command = MagicMock()
        self.props = {'idle-active': False, 'pause': False, 'demuxer-cache-duration': 15}
        self.player.property = lambda key, default=None: self.props.get(key, default)
        self.player.preparer.prepare = MagicMock()

    def begin(self):
        self.player.load_current()
        self.player.load_started_at = time.monotonic() - 5

    def loaded(self):
        self.begin()
        self.props['audio-params'] = {'samplerate': 44100}
        self.player.check_playlist()
        self.assertFalse(self.player.playlist_loading)

    def test_loading_is_not_playing_and_never_advances(self):
        self.begin()
        self.player.check_playlist()
        self.assertTrue(self.player.playlist_loading)
        self.assertFalse(self.player.track_was_active)
        self.assertEqual(self.player.current_index, 0)

    def test_failed_load_retries_same_song_once_then_stops(self):
        self.begin()
        self.props['idle-active'] = True
        self.player.check_playlist()
        self.assertIn('erneut', self.player.last_error)
        self.assertEqual(self.player.playlist_retry_count, 1)
        self.assertEqual(self.player.current_index, 0)
        self.player.playlist_retry_at = time.monotonic() - 1
        self.player.check_playlist()
        self.assertTrue(self.player.playlist_loading)
        self.player.load_started_at = time.monotonic() - 5
        self.player.check_playlist()
        self.assertTrue(self.player.resume_paused)
        self.assertIn('angehalten', self.player.last_error)
        self.assertEqual(self.player.current_index, 0)
        for _ in range(5):
            self.player.check_playlist()
        self.assertEqual(self.player.current_index, 0)
        self.assertEqual(self.player.playlist_retry_at, 0)

    def test_expired_loading_attempt_is_bounded(self):
        self.begin()
        self.player.load_started_at = time.monotonic() - 65
        self.player.check_playlist()
        self.assertFalse(self.player.playlist_loading)
        self.assertEqual(self.player.current_index, 0)
        self.assertEqual(self.player.playlist_retry_count, 1)

    def test_true_eof_advances_once_and_unpauses_next_song(self):
        self.loaded()
        self.props.update({'eof-reached': True, 'duration': 100, 'time-pos': 100, 'pause': True})
        self.player.check_playlist()
        self.assertEqual(self.player.current_index, 1)
        self.player.command.assert_any_call('set_property', 'pause', False)
        self.assertTrue(self.player.playlist_loading)

    def test_last_song_does_not_repeat_when_repeat_is_off(self):
        self.player.current_index = 1
        self.loaded()
        self.props['eof-reached'] = True
        self.player.check_playlist()
        self.player.command.reset_mock()
        self.player.check_playlist()
        self.player.command.assert_not_called()
        self.assertEqual(self.player.current_index, 1)
        self.assertTrue(self.player.resume_paused)

    def test_premature_eof_does_not_skip_song(self):
        self.loaded()
        self.props.update({'eof-reached': True, 'duration': 100, 'time-pos': 30})
        self.player.check_playlist()
        self.assertEqual(self.player.current_index, 0)
        self.assertIn('vor dem Liedende', self.player.last_error)

    def test_idle_after_playback_is_a_failure_not_eof(self):
        self.loaded()
        self.props['idle-active'] = True
        self.player.check_playlist()
        self.assertEqual(self.player.current_index, 0)
        self.assertIn('abgebrochen', self.player.last_error)

    def test_failed_ipc_does_not_skip_or_retry(self):
        self.loaded()
        self.props['idle-active'] = None
        self.player.check_playlist()
        self.assertEqual(self.player.current_index, 0)
        self.assertEqual(self.player.playlist_retry_count, 0)

    def test_next_track_prepares_only_after_audio_has_loaded(self):
        self.begin()
        self.player.check_playlist()
        self.player.preparer.prepare.assert_not_called()
        self.loaded()
        self.player.check_playlist()
        self.player.preparer.prepare.assert_called_once_with(self.player.queue[1]['url'])

    def test_next_track_waits_for_current_stream_buffer(self):
        self.loaded()
        for value in (None, 0, 9.9, float('nan'), 'invalid'):
            self.props['demuxer-cache-duration'] = value
            self.player.check_playlist()
        self.player.preparer.prepare.assert_not_called()
        self.props['demuxer-cache-duration'] = 10
        self.player.check_playlist()
        self.player.preparer.prepare.assert_called_once()

    def test_buffering_has_priority_over_next_track(self):
        self.loaded()
        self.props.update({'paused-for-cache': True, 'demuxer-cache-duration': 30})
        self.player.check_playlist()
        self.player.preparer.prepare.assert_not_called()

    def test_short_fully_cached_song_can_prepare_next(self):
        self.loaded()
        self.props.update({'demuxer-cache-duration': 2, 'demuxer-cache-state': {'eof-cached': True}})
        self.player.check_playlist()
        self.player.preparer.prepare.assert_called_once()

    def test_buffer_telemetry_is_optional_and_finite(self):
        self.player.process = MagicMock()
        self.player.process.poll.return_value = None
        with patch.object(agent, 'MPV_SOCKET', MagicMock()):
            for value in (None, 'invalid', True, float('nan'), float('inf')):
                self.props['demuxer-cache-duration'] = value
                self.assertIsNone(self.player.state()['buffer_seconds'])
            self.props['demuxer-cache-duration'] = 12.34
            self.assertEqual(self.player.state()['buffer_seconds'], 12.3)
            self.assertEqual(self.player.state()['buffer_target_seconds'], 90)
            self.player.sound_active = True
            self.assertIsNone(self.player.state()['buffer_seconds'])

    def test_initial_buffer_is_per_song_not_global_for_soundboard(self):
        self.begin()
        options = self.player.command.call_args_list[0].args[-1]
        self.assertEqual(options['cache-pause-initial'], 'yes')
        self.assertEqual(options['cache-pause-wait'], '10')
        self.assertEqual(options['cache-secs'], '90')
        self.assertEqual(options['demuxer-readahead-secs'], '90')
        self.assertEqual(options['demuxer-max-bytes'], '32MiB')

    def test_refill_threshold_changes_only_after_real_progress(self):
        self.player.load_current(position=42)
        self.player.command.reset_mock()
        self.props.update({'audio-params': {'samplerate': 44100}, 'paused-for-cache': True, 'time-pos': 42})
        self.player.check_buffering()
        self.player.command.assert_not_called()
        self.assertTrue(self.player.initial_buffer_pending)
        self.props.update({'paused-for-cache': False, 'pause': True, 'time-pos': 43})
        self.player.check_buffering()
        self.player.command.assert_not_called()
        self.props['pause'] = False
        self.player.check_buffering()
        self.player.check_buffering()
        self.player.command.assert_called_once_with('set_property', 'cache-pause-wait', 15, start=False)
        self.assertFalse(self.player.initial_buffer_pending)

    def test_missing_or_invalid_telemetry_never_releases_start_buffer(self):
        self.begin()
        self.player.command.reset_mock()
        self.props.update({'audio-params': {'samplerate': 44100}, 'paused-for-cache': False})
        for position in (None, True, float('nan'), float('inf'), 0, '1'):
            self.props['time-pos'] = position
            self.player.check_buffering()
        self.props.update({'time-pos': 1, 'paused-for-cache': None})
        self.player.check_buffering()
        self.player.command.assert_not_called()
        self.assertTrue(self.player.initial_buffer_pending)

    def test_next_song_and_retry_reset_start_reserve(self):
        self.loaded()
        self.props.update({'time-pos': 2, 'paused-for-cache': False})
        self.player.check_buffering()
        self.assertFalse(self.player.initial_buffer_pending)
        for retry in (False, True):
            self.player.load_current(retry=retry)
            self.assertTrue(self.player.initial_buffer_pending)
            self.assertEqual(self.player.command.call_args_list[-2].args[-1]['cache-pause-wait'], '10')

    def test_radio_uses_short_separate_buffer_and_retry_profile(self):
        station = {'id': 1, 'name': 'Test', 'stream_url': 'https://example.com/live'}
        self.player.ensure_mpv = MagicMock()
        self.player.checkpoint_playback = MagicMock()
        self.player.play_radio(station)
        self.player.retry_radio()
        loads = [call.args for call in self.player.command.call_args_list if call.args[0] == 'loadfile']
        self.assertEqual(len(loads), 2)
        for load in loads:
            self.assertEqual(load[-1]['cache-secs'], '30')
            self.assertEqual(load[-1]['cache-pause-wait'], '1')
        self.props.update({'time-pos': 1, 'paused-for-cache': False, 'audio-params': {'samplerate': 44100}})
        self.player.check_buffering()
        self.player.command.assert_any_call('set_property', 'cache-pause-wait', 3, start=False)

    def test_buffering_is_not_reported_as_playing(self):
        self.begin()
        self.player.process = MagicMock()
        self.player.process.poll.return_value = None
        self.props['paused-for-cache'] = True
        with patch.object(agent, 'MPV_SOCKET', MagicMock()):
            self.assertFalse(self.player.state()['playing'])
            self.assertEqual(self.player.state()['buffer_phase'], 'starting')
            self.player.initial_buffer_pending = False
            self.assertEqual(self.player.state()['buffer_phase'], 'refilling')
            self.assertEqual(self.player.state()['buffer_refill_seconds'], 15)
            self.props['pause'] = True
            self.assertEqual(self.player.state()['buffer_phase'], 'paused')

    def test_diagnostics_are_transition_only_and_contain_no_media_urls(self):
        self.begin()
        self.props.update({'paused-for-cache': True, 'audio-params': {'samplerate': 44100}})
        with patch('builtins.print') as output:
            for _ in range(5):
                self.player.check_buffering()
            self.player.observe_bluetooth(False)
            self.player.observe_bluetooth(False)
            self.player.observe_bluetooth(True)
        events = [json.loads(call.args[0]) for call in output.call_args_list]
        self.assertEqual([event['event'] for event in events],
                         ['buffer_starting', 'bluetooth_disconnected', 'bluetooth_connected'])
        self.assertNotIn('https:', json.dumps(events))

    def test_soundboard_monitor_does_not_change_buffer_threshold(self):
        self.loaded()
        self.player.command.reset_mock()
        self.player.sound_active = True
        self.props.update({'time-pos': 1, 'paused-for-cache': False})
        self.player.check_buffering()
        self.player.command.assert_not_called()

    def test_manual_start_resets_failure_budget(self):
        self.player.playlist_retry_count = 1
        self.player.last_error = 'previous error'
        self.begin()
        self.assertEqual(self.player.playlist_retry_count, 0)
        self.assertEqual(self.player.last_error, '')

    def test_prepared_stream_is_used_but_never_reused_on_retry(self):
        self.player.preparer.ready = {'source': self.player.queue[0]['url'], 'expires': time.time() + 60,
                                     'url': 'https://r1.googlevideo.com/audio', 'options': {'ytdl': 'no'}}
        self.begin()
        load = self.player.command.call_args_list[0].args
        self.assertEqual(load[1], 'https://r1.googlevideo.com/audio')
        self.assertEqual(load[-1]['keep-open'], 'yes')
        self.player.command.reset_mock()
        self.player.load_current(retry=True)
        self.assertEqual(self.player.command.call_args_list[0].args[1], self.player.queue[0]['url'])

    def test_pausing_cancels_scheduled_retry(self):
        self.begin()
        self.player.playlist_retry_at = time.monotonic() + 3
        with patch.object(self.player, 'state', return_value={}):
            self.player.act('pause')
        self.assertEqual(self.player.playlist_retry_at, 0)
        self.assertTrue(self.player.resume_paused)

    def test_radio_and_soundboard_never_advance_playlist(self):
        self.loaded()
        self.props['eof-reached'] = True
        self.player.source_mode = 'radio'
        self.player.check_playlist()
        self.assertEqual(self.player.current_index, 0)
        self.player.source_mode = 'playlist'
        self.player.sound_active = True
        self.player.check_playlist()
        self.assertEqual(self.player.current_index, 0)

    def test_resume_uses_load_options_not_early_seek(self):
        self.player.resume_position = 42
        self.player.resume_paused = True
        self.player.restore_session()
        self.assertEqual(self.player.command.call_args_list[0].args[-1]['start'], '42')
        self.player.command.assert_any_call('set_property', 'pause', True)

    def test_shuffle_and_queue_edits_do_not_prepare_wrong_song(self):
        self.assertEqual(self.player.next_url(), self.player.queue[1]['url'])
        self.player.shuffle = True
        self.assertEqual(self.player.next_url(), '')
        self.player.shuffle = False
        self.player.current_index = 1
        self.assertEqual(self.player.next_url(), '')
        self.player.repeat = 'all'
        self.assertEqual(self.player.next_url(), self.player.queue[0]['url'])


class PreparationTests(unittest.TestCase):
    def test_expired_signed_urls_are_not_reused(self):
        preparer = agent.NextTrackPreparer()
        preparer.ready = {'source': 'test', 'url': 'https://r1.googlevideo.com/audio', 'expires': time.time() - 1}
        self.assertIsNone(preparer.get('test'))

    @patch.object(agent.subprocess, 'run')
    def test_resolver_is_audio_only_bounded_and_does_not_download(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps({
            'url': 'https://r1.googlevideo.com/audio', 'vcodec': 'none',
            'http_headers': {'User-Agent': 'Test', 'Cookie': 'never store this'}}), '')
        result = agent.NextTrackPreparer.resolve('https://www.youtube.com/watch?v=aaaaaaaaaaa')
        self.assertEqual(result['options'], {'ytdl': 'no', 'user-agent': 'Test'})
        self.assertIn('-J', run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['timeout'], 50)
        self.assertLessEqual(result['expires'], time.time() + 600)

    @patch.object(agent.subprocess, 'run')
    def test_resolver_rejects_unexpected_destinations(self, run):
        for url in ['file:///etc/passwd', 'https://127.0.0.1/secret', 'https://example.com/audio']:
            run.return_value = subprocess.CompletedProcess([], 0, json.dumps({'url': url, 'vcodec': 'none'}), '')
            with self.assertRaises(ValueError):
                agent.NextTrackPreparer.resolve('https://www.youtube.com/watch?v=aaaaaaaaaaa')

    @patch.object(agent.threading, 'Thread')
    def test_only_one_background_resolver_runs(self, thread):
        preparer = agent.NextTrackPreparer()
        preparer.prepare('https://www.youtube.com/watch?v=aaaaaaaaaaa')
        preparer.prepare('https://www.youtube.com/watch?v=bbbbbbbbbbb')
        self.assertEqual(thread.call_count, 1)


if __name__ == '__main__':
    unittest.main()
