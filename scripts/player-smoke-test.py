#!/usr/bin/env python3
"""Test real mpv loading/EOF using null audio, isolated sockets and temporary state."""
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def check_network_buffer(player):
    """Exercise a real underrun on loopback, with silence and no external media."""
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(b'\x00' * 4 * 44100 * 120)
    payload = audio.getvalue()
    rate = 4 * 44100
    refill, finish, stop = threading.Event(), threading.Event(), threading.Event()

    class Stream(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            offset = 44 + 12 * rate
            try:
                self.wfile.write(payload[:offset])
                self.wfile.flush()
                # Keep the connection alive but deliver much less than playback
                # consumes. This simulates weak throughput, not a dead socket.
                deadline = time.monotonic() + 25
                while not refill.is_set() and not stop.is_set() and time.monotonic() < deadline:
                    self.wfile.write(payload[offset:offset + 1764])
                    self.wfile.flush()
                    offset += 1764
                    stop.wait(.25)
                if stop.is_set():
                    return
                self.wfile.write(payload[offset:offset + 9 * rate])
                self.wfile.flush()
                offset += 9 * rate
                finish.wait(8)
                if not stop.is_set():
                    self.wfile.write(payload[offset:])
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Stream)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        player.queue = [{'url': f'http://127.0.0.1:{server.server_port}/silence.wav', 'title': 'buffer test'}]
        player.current_index = 0
        player.load_current()
        deadline = time.monotonic() + 25
        started = underrun = False
        while time.monotonic() < deadline:
            player.check_buffering()
            player.check_playlist()
            started = started or not player.initial_buffer_pending
            if started and player.property('paused-for-cache', False):
                underrun = True
                break
            time.sleep(.1)
        assert started and underrun, 'Slow source must cause a real cache pause after initial playback'
        assert player.current_index == 0 and player.playlist_retry_count == 0, 'An underrun must not skip or restart the song'
        refill.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (player.buffered_seconds() or 0) < 7:
            time.sleep(.1)
        buffered = player.buffered_seconds()
        assert buffered is not None and 7 <= buffered < 15, f'Expected partial refill: {buffered!r}'
        time.sleep(.4)
        assert player.property('paused-for-cache', False), 'Nine seconds must not release the 15-second refill threshold'
        finish.set()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            player.check_buffering()
            if not player.property('paused-for-cache', True) and (player.buffered_seconds() or 0) >= 80:
                break
            time.sleep(.1)
        assert not player.property('paused-for-cache', True), 'Playback must resume after enough data arrives'
        assert (player.buffered_seconds() or 0) >= 80, 'Player must actually fill the larger cache, not just advertise it'
        assert player.current_index == 0 and player.playlist_retry_count == 0
        print('OK: real HTTP underrun, 15-second refill gate and >80-second audio reserve', flush=True)
    finally:
        stop.set()
        refill.set()
        finish.set()
        player.command('stop', start=False)
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / 'player_agent.py'
    with tempfile.TemporaryDirectory(prefix='clubiq-player-test-') as temporary:
        root = Path(temporary)
        os.environ['PLAYER_MPV_SOCKET'] = str(root / 'mpv.sock')
        os.environ['PLAYER_STATE_FILE'] = str(root / 'state.json')
        spec = importlib.util.spec_from_file_location('tested_player', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        player = module.MpvController()
        player.process = subprocess.Popen([
            'mpv', '--no-config', '--idle=yes', '--ao=null', '--vid=no', '--really-quiet',
            f'--input-ipc-server={root / "mpv.sock"}',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        player.ensure_mpv = lambda: None
        try:
            for _ in range(50):
                if (root / 'mpv.sock').exists():
                    break
                time.sleep(.1)
            for name in ('a', 'b'):
                with wave.open(str(root / f'{name}.wav'), 'wb') as audio:
                    audio.setnchannels(2)
                    audio.setsampwidth(2)
                    audio.setframerate(44100)
                    audio.writeframes(b'\x00' * 4 * 44100 * 2)
            player.queue = [{'url': str(root / f'{name}.wav'), 'title': name} for name in ('a', 'b')]
            player.current_index = 0
            player.load_current()
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                player.check_buffering()
                player.check_playlist()
                if player.current_index == 1 and player.end_handled:
                    break
                time.sleep(.1)
            assert player.current_index == 1 and player.end_handled, 'Real EOF did not advance/stop correctly'
            assert player.property('pause'), 'Final EOF must remain paused'
            print('OK: real mpv EOF advances exactly once and stops at queue end', flush=True)
            # Inspect the actual per-file mpv options, not only the Python mocks.
            player.current_index = 0
            player.load_current(play=False)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not player.property('audio-params', None):
                time.sleep(.1)
            assert float(player.property('cache-secs')) == 90, 'Song target must be 90 seconds'
            assert float(player.property('cache-pause-wait')) == 10, 'Initial reserve must be 10 seconds'
            player.command('set_property', 'pause', False)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and player.initial_buffer_pending:
                player.check_buffering()
                time.sleep(.1)
            assert not player.initial_buffer_pending, 'Short fully cached songs must start without ten seconds of media'
            assert float(player.property('cache-pause-wait')) == 15, 'Refill reserve must rise only after playback starts'
            # A real file change must clear the song settings even after runtime changes.
            player.command('loadfile', str(root / 'b.wav'), 'replace', -1, module.buffer_options('radio'))
            time.sleep(.2)
            assert float(player.property('cache-secs')) == 30, 'Radio must not inherit song target'
            assert float(player.property('cache-pause-wait')) == 1, 'Radio starts with one second'
            player.command('loadfile', str(root / 'a.wav'), 'replace', -1,
                           {'cache': 'no', 'cache-pause-initial': 'no', 'keep-open': 'no'})
            time.sleep(.2)
            cache = player.property('cache')
            # mpv's JSON IPC represents the flag-choice "no" as false on 0.40.
            assert cache is False or cache == 'no', f'Soundboard must not inherit song caching: {cache!r}'
            print('OK: real per-file buffer profiles, short songs and refill threshold', flush=True)
            check_network_buffer(player)
            player.queue[0]['url'] = str(root / 'missing.wav')
            player.current_index = 0
            player.load_current()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                player.check_playlist()
                if player.resume_paused and 'angehalten' in player.last_error:
                    break
                time.sleep(.1)
            assert player.current_index == 0, 'Broken file must never advance queue'
            assert player.playlist_retry_count == 1 and player.resume_paused, 'Retry must be bounded'
            print('OK: real mpv error retries same file once, then stops', flush=True)
        finally:
            player.stop_mpv()


if __name__ == '__main__':
    main()
