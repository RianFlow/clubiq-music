#!/usr/bin/env python3
"""Test real mpv loading/EOF using null audio, isolated sockets and temporary state."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import wave


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
                player.check_playlist()
                if player.current_index == 1 and player.end_handled:
                    break
                time.sleep(.1)
            assert player.current_index == 1 and player.end_handled, 'Real EOF did not advance/stop correctly'
            assert player.property('pause'), 'Final EOF must remain paused'
            print('OK: real mpv EOF advances exactly once and stops at queue end', flush=True)
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
