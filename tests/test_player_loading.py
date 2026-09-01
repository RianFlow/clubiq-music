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
        self.props = {'idle-active': False, 'pause': False}
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
